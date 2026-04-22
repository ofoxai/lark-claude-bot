import {
  isDuplicate,
  sendCard,
  sendText,
  sendProgressCard,
  updateProgressCard,
  addReaction,
  removeReaction,
  downloadResource,
} from "./lark.js";
import { runClaude, resumeSummary, abortClaude } from "./claude.js";
import type { TodoItem, ClaudeOptions, ClaudeResult } from "./claude.js";
import { addDialog, MEMORY_UPDATE_SUFFIX } from "./memory.js";
import { sanitizeOutput, auditOutput } from "./safety.js";
import { storeMessage, buildChatContext } from "./chatStore.js";
import { buildTaskContext } from "./taskCommands.js";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

function extractText(content: string): string {
  try {
    const obj = JSON.parse(content);
    const text: string = obj.text || "";
    return text.replace(/@_user_\w+\s*/g, "").trim();
  } catch {
    return content;
  }
}

/**
 * Build a prompt for Claude from different message types.
 * Images and files are downloaded locally first, paths passed to Claude.
 */
async function buildPromptFromMessage(
  msgType: string,
  content: string,
  message: Record<string, unknown>
): Promise<string> {
  const messageId = message.message_id as string;

  switch (msgType) {
    case "text":
      return extractText(content);

    case "post": {
      try {
        const obj = JSON.parse(content);
        const parts: string[] = [];
        if (obj.title) parts.push(obj.title);
        for (const line of obj.content || []) {
          if (!Array.isArray(line)) continue;
          for (const item of line) {
            if (item.tag === "text") {
              const text = (item.text || "").replace(/@_user_\w+\s*/g, "").trim();
              if (text) parts.push(text);
            } else if (item.tag === "img" && item.image_key) {
              const savePath = `/tmp/lark_img_${item.image_key}.png`;
              try {
                await downloadResource(messageId, item.image_key, "image", savePath);
                parts.push(`[图片已下载到 ${savePath}，请用 Read 工具查看]`);
              } catch {
                parts.push(`[图片下载失败 image_key=${item.image_key}]`);
              }
            } else if (item.tag === "a") {
              parts.push(item.text || item.href || "");
            }
          }
        }
        return parts.join(" ").trim();
      } catch {
        return content;
      }
    }

    case "image": {
      try {
        const obj = JSON.parse(content);
        const imageKey = obj.image_key || "";
        const savePath = `/tmp/lark_img_${imageKey}.png`;
        await downloadResource(messageId, imageKey, "image", savePath);
        return `用户发送了一张图片，已下载到 ${savePath}。请用 Read 工具查看图片内容并回复。`;
      } catch (err) {
        console.error("[handler] Image download failed:", err);
        return "用户发送了一张图片，但下载失败。";
      }
    }

    case "file": {
      try {
        const obj = JSON.parse(content);
        const fileKey = obj.file_key || "";
        const fileName = obj.file_name || "file";
        const savePath = `/tmp/lark_file_${fileKey}_${fileName}`;
        await downloadResource(messageId, fileKey, "file", savePath);
        return `用户发送了文件「${fileName}」，已下载到 ${savePath}。请用 Read 工具查看文件内容并回复。`;
      } catch (err) {
        console.error("[handler] File download failed:", err);
        return `用户发送了文件，但下载失败。`;
      }
    }

    default:
      return "";
  }
}

function isBotMentioned(message: Record<string, unknown>): boolean {
  const mentions = message.mentions as Array<{
    key?: string;
    name?: string;
    id?: { open_id?: string };
  }>[] | undefined;
  if (!mentions || !Array.isArray(mentions)) return false;
  const botName = config.bot.name;
  return (mentions as Array<{ key?: string; name?: string }>).some(
    (m) => m.name?.toLowerCase() === botName.toLowerCase()
  );
}

// ==================== Session management ====================

const SESSIONS_FILE = join(config.dataDir, "sessions.json");
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RESUME_ATTEMPTS = 2;

interface SessionEntry {
  sessionId: string;
  updatedAt: number;
  progressMsgId?: string;
  chatId?: string;
  active?: boolean;
  resumeAttempts?: number;
}
const chatSessions = new Map<string, SessionEntry>();

// Restore sessions from disk on startup
try {
  const saved = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) as Record<string, SessionEntry>;
  const now = Date.now();
  for (const [chatId, entry] of Object.entries(saved)) {
    if (now - entry.updatedAt < SESSION_TTL_MS) {
      chatSessions.set(chatId, entry);
    }
  }
  console.log(`[session] Restored ${chatSessions.size} sessions`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error("[session] Failed to load sessions.json:", (err as Error).message);
  }
}

/** Atomic write sessions.json (write tmp + rename) */
function persistSessions(): void {
  try {
    const obj: Record<string, SessionEntry> = {};
    for (const [k, v] of chatSessions) obj[k] = v;
    const tmpFile = SESSIONS_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmpFile, SESSIONS_FILE);
  } catch { /* ignore */ }
}

function getSessionId(chatId: string): string | undefined {
  const s = chatSessions.get(chatId);
  if (!s) return undefined;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    chatSessions.delete(chatId);
    return undefined;
  }
  return s.sessionId;
}

/** Save session, merging with existing entry fields */
function saveSessionId(chatId: string, sessionId: string, progressMsgId?: string): void {
  const existing = chatSessions.get(chatId);
  chatSessions.set(chatId, {
    ...existing,
    sessionId,
    updatedAt: Date.now(),
    progressMsgId: progressMsgId ?? existing?.progressMsgId,
  });
  persistSessions();
}

// ==================== Concurrency lock + interrupt rate limiting ====================

const chatLocks = new Map<string, number>();

// Interrupt rate limiting: prevent message flooding causing infinite abort+resume
const interruptHistory = new Map<string, { count: number; windowStart: number }>();
const MAX_INTERRUPTS = 3;
const INTERRUPT_WINDOW_MS = 60_000;
const MAX_RESUME_DEPTH = 3;

function shouldAllowInterrupt(chatId: string): boolean {
  const now = Date.now();
  const entry = interruptHistory.get(chatId);
  if (!entry || now - entry.windowStart > INTERRUPT_WINDOW_MS) {
    interruptHistory.set(chatId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_INTERRUPTS) return false;
  entry.count++;
  return true;
}

function acquireChatLock(chatId: string): boolean {
  const startedAt = chatLocks.get(chatId);
  if (startedAt !== undefined) {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 3_660_000) {
      return false; // still processing
    }
    console.log(`[lock] ${chatId.slice(0, 12)} stale lock cleared (${Math.round(elapsed / 1000)}s)`);
  }
  chatLocks.set(chatId, Date.now());
  return true;
}

function releaseChatLock(chatId: string): void {
  chatLocks.delete(chatId);
}

// ==================== Reaction emoji names ====================

const REACTION_QUEUED = "Wait";
const REACTION_WORKING = "OnIt";
const REACTION_DONE = "Done";

// ==================== Message queue ====================

interface QueuedMessage {
  chatId: string;
  chatType: string;
  chatName: string;
  messageId?: string;
  prompt: string;
  sender: string;
  queuedReactionId?: string;
}

const messageQueues = new Map<string, QueuedMessage[]>();
const MAX_QUEUE_SIZE = 10;

// Admin interrupts pre-add a Working reaction to the new message; the resumed
// processMessage takes ownership so the Working→Done (or remove) lifecycle stays
// tied to the actual worker, not the handler that caught the interrupt.
const pendingInterruptReaction = new Map<string, { messageId: string; reactionId: string }>();

function enqueueMessage(m: QueuedMessage): boolean {
  const q = messageQueues.get(m.chatId) ?? [];
  if (q.length >= MAX_QUEUE_SIZE) return false;
  q.push(m);
  messageQueues.set(m.chatId, q);
  return true;
}

function dequeueMessage(chatId: string): QueuedMessage | undefined {
  const q = messageQueues.get(chatId);
  if (!q || q.length === 0) return undefined;
  const m = q.shift()!;
  if (q.length === 0) messageQueues.delete(chatId);
  return m;
}

function requeueFront(m: QueuedMessage): void {
  const q = messageQueues.get(m.chatId) ?? [];
  q.unshift(m);
  messageQueues.set(m.chatId, q);
}

/**
 * Drain the next queued message for a chat, fire-and-forget.
 * Any path that releases a chat lock must call this, otherwise queued
 * messages sit forever.
 */
function drainChatQueue(chatId: string): void {
  const next = dequeueMessage(chatId);
  if (!next) return;
  setImmediate(() => {
    if (!acquireChatLock(next.chatId)) {
      // A fresh message beat us to the lock — put this one back at the front
      // so the next release will retry.
      requeueFront(next);
      return;
    }
    processMessage(
      next.chatId, next.chatType, next.chatName,
      next.messageId, next.prompt, next.sender, 0,
      next.queuedReactionId,
    ).catch(e => console.error("[queue drain]", e));
  });
}

// ==================== Shared: Claude execution + progress card ====================

interface ProgressContext {
  chatId: string;
  initialProgressMsgId?: string;
  replyToMsgId?: string;
  taskTitle?: string;
}

interface ExecuteResult {
  reply: string;
  sessionId?: string;
  progressMsgId?: string;
  todos: TodoItem[];
  aborted?: boolean;
}

/**
 * Execute Claude and manage progress card lifecycle.
 * Shared by handleMessage and resumeSession.
 */
async function executeClaudeWithProgress(
  prompt: string,
  claudeOpts: ClaudeOptions,
  ctx: ProgressContext
): Promise<ExecuteResult> {
  let progressMsgId = ctx.initialProgressMsgId;
  let progressCardFailed = false;
  let progressDone = false;
  let currentTodos: TodoItem[] = [];
  let lastActivity = "";
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const PROGRESS_THROTTLE = 3000;
  let lastProgressUpdate = 0;

  function buildProgressMarkdown(): string {
    const lines: string[] = [];
    if (ctx.taskTitle) {
      lines.push(`**${sanitizeOutput(ctx.taskTitle)}**\n`);
    }
    if (currentTodos.length > 0) {
      for (const t of currentTodos) {
        const icon = t.status === "completed" ? "✅"
          : t.status === "in_progress" ? "🔄" : "⬜";
        lines.push(`${icon} ${sanitizeOutput(t.content)}`);
      }
    }
    if (lastActivity) {
      lines.push(`\n⏳ ${sanitizeOutput(lastActivity)}…`);
    }
    return lines.join("\n") || "⏳ 处理中…";
  }

  async function updateProgress() {
    if (progressDone || progressCardFailed) return;
    const now = Date.now();
    if (now - lastProgressUpdate < PROGRESS_THROTTLE) {
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => { pendingTimer = undefined; updateProgress(); }, PROGRESS_THROTTLE);
      }
      return;
    }
    lastProgressUpdate = now;
    const md = buildProgressMarkdown();
    try {
      if (!progressMsgId) {
        progressMsgId = await sendProgressCard(ctx.chatId, md, ctx.replyToMsgId);
        if (!progressMsgId) {
          progressCardFailed = true;
        } else {
          const s = chatSessions.get(ctx.chatId);
          if (s) { s.progressMsgId = progressMsgId; persistSessions(); }
        }
      } else {
        const ok = await updateProgressCard(progressMsgId, md);
        if (!ok) progressCardFailed = true;
      }
    } catch (err) {
      console.error("[handler] Progress update failed:", (err as Error).message);
      progressCardFailed = true;
    }
  }

  const result = await runClaude(prompt, {
    ...claudeOpts,
    onTodoUpdate: (todos) => { currentTodos = todos; updateProgress(); },
    onToolUse: (_tn, summary) => { lastActivity = summary; updateProgress(); },
  });

  // Stop progress updates
  progressDone = true;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = undefined; }

  if (result.sessionId) {
    saveSessionId(ctx.chatId, result.sessionId, progressMsgId);
  }

  // If aborted, don't clear active flag — resume will take over
  if (result.aborted) {
    return { reply: "", sessionId: result.sessionId, progressMsgId, todos: currentTodos, aborted: true };
  }

  // Clear active flag
  const entry = chatSessions.get(ctx.chatId);
  if (entry) { entry.active = false; entry.resumeAttempts = 0; persistSessions(); }

  // Safety audit
  auditOutput(prompt, result.output);

  // Build reply
  let reply = result.output;
  if (result.timedOut) {
    reply = reply
      ? `${reply}\n\n⚠️ 处理超时，以上是部分结果`
      : "⚠️ 处理超时，请稍后再试";
  }
  if (!reply && result.sessionId) {
    reply = await resumeSummary(result.sessionId);
  }
  if (!reply) reply = "已完成。";
  reply = sanitizeOutput(reply);

  // Send final result
  if (progressMsgId) {
    const titleSection = ctx.taskTitle ? `**${sanitizeOutput(ctx.taskTitle)}**\n\n` : "";
    const todoSection = currentTodos.length > 0
      ? currentTodos.map((t) => {
          const icon = t.status === "completed" ? "✅"
            : t.status === "in_progress" ? "🔄" : "⬜";
          return `${icon} ${sanitizeOutput(t.content)}`;
        }).join("\n") + "\n\n"
      : "";
    const updated = await updateProgressCard(progressMsgId, titleSection + todoSection + reply);
    if (!updated) {
      try { await sendCard(ctx.chatId, reply, undefined, ctx.replyToMsgId); } catch {
        try { await sendCard(ctx.chatId, reply); } catch { /* give up */ }
      }
    }
  } else {
    try {
      await sendCard(ctx.chatId, reply, undefined, ctx.replyToMsgId);
    } catch {
      try { await sendCard(ctx.chatId, reply); } catch { /* give up */ }
    }
  }

  return { reply, sessionId: result.sessionId, progressMsgId, todos: currentTodos };
}

// ==================== Auto-resume ====================

/**
 * Resume interrupted active sessions on startup (sequential to avoid spawning many Claude processes)
 */
export async function resumeInterruptedSessions(): Promise<void> {
  const interrupted: Array<[string, SessionEntry]> = [];
  for (const [chatId, entry] of chatSessions) {
    if (entry.active && (entry.resumeAttempts ?? 0) < MAX_RESUME_ATTEMPTS) {
      interrupted.push([chatId, entry]);
    } else if (entry.active) {
      console.log(`[session] ${chatId.slice(0, 12)} max resume attempts reached, skipping`);
      entry.active = false;
      persistSessions();
    }
  }
  if (interrupted.length === 0) return;

  console.log(`[session] Found ${interrupted.length} interrupted active sessions, resuming sequentially`);

  for (const [chatId, entry] of interrupted) {
    try {
      await resumeSession(chatId, entry);
    } catch (err) {
      console.error(`[session] Resume ${chatId.slice(0, 12)} failed:`, err);
    }
  }
}

async function resumeSession(chatId: string, entry: SessionEntry): Promise<void> {
  if (!acquireChatLock(chatId)) return;

  // Track retry count
  entry.resumeAttempts = (entry.resumeAttempts ?? 0) + 1;
  persistSessions();

  console.log(`[session] Resuming: chat=${chatId.slice(0, 12)} session=${entry.sessionId.slice(0, 8)} attempt=${entry.resumeAttempts}`);

  try {
    const { reply } = await executeClaudeWithProgress(
      "你之前的任务被中断了。请检查你的 todo 列表，继续完成剩余的未完成任务。",
      { sessionId: entry.sessionId, logTag: chatId.slice(0, 16) },
      { chatId, initialProgressMsgId: entry.progressMsgId }
    );

    addDialog({
      chatId,
      chatName: chatId.slice(0, 12),
      sender: "bot",
      prompt: "[auto-resume interrupted task]",
      response: reply.slice(0, 500),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[session] Resume execution failed:`, err);
    entry.active = false;
    persistSessions();
    try { await sendText(chatId, "任务恢复失败，请重新发送指令。"); } catch { /* ignore */ }
  } finally {
    releaseChatLock(chatId);
    drainChatQueue(chatId);
  }
}

// ==================== Message handling ====================

export async function handleMessage(
  data: Record<string, unknown>
): Promise<void> {
  const message = data.message as Record<string, unknown>;
  if (!message) return;

  const messageId = message.message_id as string;
  const chatId = message.chat_id as string;
  const chatType = message.chat_type as string;
  const msgType = message.message_type as string;
  const content = (message.content as string) || "{}";

  if (isDuplicate(messageId)) return;

  storeMessage(data);

  if (chatType === "group" && !isBotMentioned(message)) return;

  const SUPPORTED_TYPES = ["text", "post", "image", "file"];
  if (!SUPPORTED_TYPES.includes(msgType)) return;

  const prompt = await buildPromptFromMessage(msgType, content, message);
  if (!prompt) return;

  const chatName = chatType === "p2p" ? "私聊" : chatId.slice(0, 12);
  console.log(`[msg] ${chatName} → ${prompt.slice(0, 60)}`);

  const senderId =
    ((data.sender as Record<string, unknown>)?.sender_id as Record<string, unknown>)
      ?.open_id as string || "unknown";

  // If currently processing: admin can interrupt (rate-limited); otherwise enqueue.
  if (!acquireChatLock(chatId)) {
    const adminOpenId = config.bot.adminOpenId;
    if (adminOpenId && senderId === adminOpenId && shouldAllowInterrupt(chatId)) {
      console.log(`[interrupt] ${chatId.slice(0, 12)} admin interrupt, injecting new message`);
      abortClaude(chatId);
      if (messageId) {
        const rxId = await addReaction(messageId, REACTION_WORKING);
        if (rxId) {
          // Clear any prior pending interrupt reaction so we don't leak Working emojis
          const old = pendingInterruptReaction.get(chatId);
          if (old) await removeReaction(old.messageId, old.reactionId);
          pendingInterruptReaction.set(chatId, { messageId, reactionId: rxId });
        }
      }
      return;
    }
    // Queue: add Wait reaction; drained after the current task finishes.
    const waitReactionId = messageId ? await addReaction(messageId, REACTION_QUEUED) : undefined;
    const enqueued = enqueueMessage({
      chatId, chatType, chatName, messageId, prompt, sender: senderId,
      queuedReactionId: waitReactionId,
    });
    if (!enqueued) {
      if (waitReactionId && messageId) await removeReaction(messageId, waitReactionId);
      await sendText(chatId, `${config.bot.name} 队列已满，请稍后再试。`);
      console.log(`[queue] ${chatId.slice(0, 12)} queue full (${MAX_QUEUE_SIZE}), dropping message`);
    } else {
      console.log(`[queue] ${chatId.slice(0, 12)} enqueued (size=${messageQueues.get(chatId)?.length ?? 0})`);
    }
    return;
  }

  await processMessage(chatId, chatType, chatName, messageId, prompt, senderId, 0);
}

async function processMessage(
  chatId: string,
  chatType: string,
  chatName: string,
  messageId: string | undefined,
  prompt: string,
  sender: string,
  depth: number,
  queuedReactionId?: string,
  preAddedReactionId?: string
): Promise<void> {
  // Dequeued message: drop the Wait reaction before replacing it with Working
  if (queuedReactionId && messageId) {
    await removeReaction(messageId, queuedReactionId);
  }
  // Admin interrupt already added Working to the new message; reuse it rather
  // than stacking a second reaction.
  let reactionId: string | undefined = preAddedReactionId
    ?? (messageId ? await addReaction(messageId, REACTION_WORKING) : undefined);
  let succeeded = false;

  try {
    const chatCtx = buildChatContext(chatId, 30);
    const TASK_KEYWORDS = ["任务", "定时", "cron", "schedule", "提醒", "每天", "每周", "执行", "暂停", "删除", "立即", "停止", "新建", "创建", "修改", "更新"];
    const hasTaskKeyword = TASK_KEYWORDS.some(kw => prompt.includes(kw));

    const parts: string[] = [];

    // 1. 近期对话上下文
    if (chatCtx) parts.push(chatCtx);

    // 2. 当前需要处理的消息（重点标出）
    parts.push(`## 当前消息（需要你处理）\n${prompt}`);

    // 3. 按需附加：定时任务提示（关键词命中时注入，否则跳过）
    if (hasTaskKeyword) {
      const taskCtx = buildTaskContext(chatId);
      if (taskCtx) parts.push(taskCtx);
    }

    // 4. 执行规范
    parts.push(`## 执行规范\n- 执行后检查结果是否符合预期，如有报错或异常请自行排查并重试，不要直接把错误抛给用户\n- 操作完成后简洁回复结果，不要复述操作过程`);

    parts.push(MEMORY_UPDATE_SUFFIX);
    const fullPrompt = parts.join("\n\n---\n\n");

    const existingSession = getSessionId(chatId);

    // Mark as active, clear old progress card ID (new message gets its own card)
    const sessionEntry = chatSessions.get(chatId);
    if (sessionEntry) {
      sessionEntry.active = true;
      sessionEntry.chatId = chatId;
      sessionEntry.progressMsgId = undefined;
      persistSessions();
    }

    // 从 prompt 首行截取任务标题，供进度卡片头部显示（递归恢复时不覆盖标题）
    const taskTitle = depth === 0
      ? prompt.replace(/\n[\s\S]*/u, "").trim().slice(0, 20) || undefined
      : undefined;

    const { reply, sessionId: newSessionId, aborted } = await executeClaudeWithProgress(
      fullPrompt,
      { sessionId: existingSession, logTag: chatId.slice(0, 16), chatId },
      {
        chatId,
        initialProgressMsgId: undefined,
        replyToMsgId: messageId,
        taskTitle,
      }
    );

    // If aborted (user sent a new message), resume the same session
    if (aborted) {
      if (reactionId && messageId) {
        await removeReaction(messageId, reactionId);
        reactionId = undefined; // prevent the finally block removing it again
      }

      // Hand the pre-added Working reaction on the interrupting message off to
      // the recursive call, which will carry it through to Done / remove.
      const pending = pendingInterruptReaction.get(chatId);
      pendingInterruptReaction.delete(chatId);

      if (!newSessionId) {
        console.log(`[interrupt] ${chatId.slice(0, 12)} abort with no sessionId, starting new session`);
      } else if (depth >= MAX_RESUME_DEPTH) {
        console.log(`[interrupt] ${chatId.slice(0, 12)} max resume depth ${MAX_RESUME_DEPTH} reached, stopping`);
        if (pending) await removeReaction(pending.messageId, pending.reactionId);
        await sendText(chatId, "收到你的消息了，等当前工作告一段落后处理。");
        return;
      } else {
        console.log(`[interrupt] ${chatId.slice(0, 12)} aborted, resuming session ${newSessionId.slice(0, 8)} (depth=${depth + 1})`);
      }

      // Don't release lock, recurse (outermost finally releases + drains queue)
      await processMessage(chatId, chatType, chatName,
        pending?.messageId,
        "用户在你执行任务时发送了新消息。查看最近群消息，判断是否需要调整当前任务方向。如果用户明确要求停止或取消，就停下来；否则继续。",
        sender, depth + 1,
        undefined,
        pending?.reactionId);
      return;
    }

    // Race: abort signal arrived late but the task finished naturally.
    // Clean up any leftover Working reaction on the interrupting message.
    const staleInterrupt = pendingInterruptReaction.get(chatId);
    if (staleInterrupt) {
      pendingInterruptReaction.delete(chatId);
      await removeReaction(staleInterrupt.messageId, staleInterrupt.reactionId);
    }

    storeMessage({
      message: {
        message_id: `bot_${Date.now()}`,
        chat_id: chatId,
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: reply.slice(0, 2000) }),
        create_time: String(Date.now()),
      },
      sender: {
        sender_id: { open_id: "bot" },
        sender_type: "bot",
      },
    });

    addDialog({
      chatId,
      chatName,
      sender,
      prompt,
      response: reply.slice(0, 500),
      timestamp: new Date().toISOString(),
    });

    succeeded = true;
  } catch (err) {
    console.error("[handler] Error:", err);
    const s = chatSessions.get(chatId);
    if (s) { s.active = false; persistSessions(); }
    try {
      await sendText(chatId, "处理消息时出现错误，请稍后再试");
    } catch { /* give up */ }
  } finally {
    // Working → Done on success; just remove Working on failure/abort.
    if (messageId) {
      if (reactionId) {
        await removeReaction(messageId, reactionId);
      }
      if (succeeded) {
        await addReaction(messageId, REACTION_DONE);
      }
    }

    // Only the outermost call releases the lock and drains the queue — recursive
    // calls run inside the same lock scope.
    if (depth === 0) {
      releaseChatLock(chatId);
      drainChatQueue(chatId);
    }
  }
}
