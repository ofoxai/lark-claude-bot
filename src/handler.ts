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

// ==================== Shared: Claude execution + progress card ====================

interface ProgressContext {
  chatId: string;
  initialProgressMsgId?: string;
  replyToMsgId?: string;
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
        await updateProgressCard(progressMsgId, md);
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
    try {
      const todoSection = currentTodos.length > 0
        ? currentTodos.map((t) => {
            const icon = t.status === "completed" ? "✅"
              : t.status === "in_progress" ? "🔄" : "⬜";
            return `${icon} ${sanitizeOutput(t.content)}`;
          }).join("\n") + "\n\n"
        : "";
      await updateProgressCard(progressMsgId, todoSection + reply);
    } catch {
      try { await sendCard(ctx.chatId, reply); } catch { /* give up */ }
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

  // If currently processing: admin can interrupt, others wait
  if (!acquireChatLock(chatId)) {
    const adminOpenId = config.bot.adminOpenId;
    if (adminOpenId && senderId === adminOpenId && shouldAllowInterrupt(chatId)) {
      console.log(`[interrupt] ${chatId.slice(0, 12)} admin interrupt, injecting new message`);
      abortClaude(chatId);
      await addReaction(messageId, "OnIt");
    } else if (adminOpenId && senderId === adminOpenId) {
      await sendText(chatId, "中断太频繁，请等当前任务完成。");
    } else {
      await sendText(chatId, `${config.bot.name} 正在处理任务中，请稍候。`);
    }
    // Message is already saved via storeMessage; abort+resume will pick it up
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
  depth: number
): Promise<void> {
  const reactionId = messageId ? await addReaction(messageId, "OnIt") : undefined;

  try {
    const chatCtx = buildChatContext(chatId, 30);
    const taskCtx = buildTaskContext(chatId);

    const parts: string[] = [];
    if (chatCtx) parts.push(chatCtx);
    if (taskCtx) parts.push(taskCtx);
    parts.push(`用户消息：${prompt}`);
    parts.push(MEMORY_UPDATE_SUFFIX);
    const fullPrompt = parts.join("\n\n---\n\n");

    const existingSession = getSessionId(chatId);

    // Mark as active
    const sessionEntry = chatSessions.get(chatId);
    if (sessionEntry) {
      sessionEntry.active = true;
      sessionEntry.chatId = chatId;
      persistSessions();
    }

    const { reply, sessionId: newSessionId, aborted } = await executeClaudeWithProgress(
      fullPrompt,
      { sessionId: existingSession, logTag: chatId.slice(0, 16), chatId },
      {
        chatId,
        initialProgressMsgId: sessionEntry?.progressMsgId,
        replyToMsgId: messageId,
      }
    );

    // If aborted (user sent a new message), resume the same session
    if (aborted) {
      if (reactionId && messageId) {
        await removeReaction(messageId, reactionId);
      }

      if (!newSessionId) {
        // Aborted too early, no session ID yet — start a new session
        console.log(`[interrupt] ${chatId.slice(0, 12)} abort with no sessionId, starting new session`);
      } else if (depth >= MAX_RESUME_DEPTH) {
        console.log(`[interrupt] ${chatId.slice(0, 12)} max resume depth ${MAX_RESUME_DEPTH} reached, stopping`);
        await sendText(chatId, "收到你的消息了，等当前工作告一段落后处理。");
        return;
      } else {
        console.log(`[interrupt] ${chatId.slice(0, 12)} aborted, resuming session ${newSessionId.slice(0, 8)} (depth=${depth + 1})`);
      }

      // Don't release lock, recurse (outermost finally releases)
      await processMessage(chatId, chatType, chatName, undefined,
        "你正在执行任务时，用户发送了新消息。请查看群聊最近消息记录中用户的新消息，然后自行判断：\n" +
        "- 如果新消息与当前任务相关（补充信息、修改方向、取消任务等），请据此调整并继续\n" +
        "- 如果新消息是一个全新的、无关的任务，请先完成当前任务，再处理新任务\n" +
        "- 如果用户明确要求取消或停止当前任务，就停下来",
        sender, depth + 1);
      return;
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
  } catch (err) {
    console.error("[handler] Error:", err);
    const s = chatSessions.get(chatId);
    if (s) { s.active = false; persistSessions(); }
    try {
      await sendText(chatId, "处理消息时出现错误，请稍后再试");
    } catch { /* give up */ }
  } finally {
    releaseChatLock(chatId);
    if (reactionId && messageId) {
      await removeReaction(messageId, reactionId);
    }
  }
}
