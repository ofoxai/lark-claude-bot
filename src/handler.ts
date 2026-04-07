import {
  isDuplicate,
  sendCard,
  sendText,
  addReaction,
  removeReaction,
  downloadResource,
} from "./lark.js";
import { runClaude, resumeSummary } from "./claude.js";
import { addDialog, MEMORY_UPDATE_SUFFIX } from "./memory.js";
import { sanitizeOutput, auditOutput } from "./safety.js";
import { storeMessage, buildChatContext } from "./chatStore.js";
import { buildTaskContext } from "./taskCommands.js";
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
 * 从不同消息类型构建给 Claude 的 prompt
 * 图片和文件会先下载到本地，把路径传给 Claude
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
              // 下载富文本中的图片
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

// 会话管理
const chatSessions = new Map<string, { sessionId: string; updatedAt: number }>();
const SESSION_TTL_MS = 30 * 60 * 1000;

function getSessionId(chatId: string): string | undefined {
  const s = chatSessions.get(chatId);
  if (!s) return undefined;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    chatSessions.delete(chatId);
    return undefined;
  }
  return s.sessionId;
}

function saveSessionId(chatId: string, sessionId: string): void {
  chatSessions.set(chatId, { sessionId, updatedAt: Date.now() });
}

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

  // 支持多种消息类型
  const SUPPORTED_TYPES = ["text", "post", "image", "file"];
  if (!SUPPORTED_TYPES.includes(msgType)) return;

  const prompt = await buildPromptFromMessage(msgType, content, message);
  if (!prompt) return;

  const chatName = chatType === "p2p" ? "私聊" : chatId.slice(0, 12);
  console.log(`[msg] ${chatName} → ${prompt.slice(0, 60)}`);

  const sender =
    ((data.sender as Record<string, unknown>)?.sender_id as Record<string, unknown>)
      ?.open_id as string || "unknown";

  const reactionId = await addReaction(messageId, "OnIt");

  try {
    // 构建完整上下文
    const chatCtx = buildChatContext(chatId, 30);
    const taskCtx = buildTaskContext(chatId);

    const parts: string[] = [];
    if (chatCtx) parts.push(chatCtx);
    if (taskCtx) parts.push(taskCtx);
    parts.push(`用户消息：${prompt}`);
    parts.push(MEMORY_UPDATE_SUFFIX);
    const fullPrompt = parts.join("\n\n---\n\n");

    const existingSession = getSessionId(chatId);
    const result = await runClaude(fullPrompt, {
      sessionId: existingSession,
      timeoutMs: 600_000,
      logTag: chatId.slice(0, 16),
    });

    if (result.sessionId) {
      saveSessionId(chatId, result.sessionId);
    }

    auditOutput(prompt, result.output);

    let reply = result.output;
    if (result.timedOut) {
      reply = reply
        ? `${reply}\n\n⚠️ 处理超时，以上是部分结果`
        : "⚠️ 处理超时，请稍后再试";
    }
    if (!reply && result.sessionId) {
      // Claude 执行了操作但没生成文本总结，resume 获取总结
      reply = await resumeSummary(result.sessionId);
    }
    if (!reply) {
      reply = "已完成。";
    }

    reply = sanitizeOutput(reply);

    // 发送回复：先尝试 reply，失败则 fallback 到直发
    try {
      await sendCard(chatId, reply, undefined, messageId);
    } catch {
      try {
        // reply 失败，尝试不带 reply 直接发
        await sendCard(chatId, reply);
      } catch (sendErr) {
        console.error("[handler] Send failed:", (sendErr as Error).message);
      }
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
    try {
      // 错误消息不 reply（reply 本身可能就是问题），直接发到群
      await sendText(chatId, "处理消息时出现错误，请稍后再试");
    } catch { /* 连发消息都失败就放弃 */ }
  } finally {
    if (reactionId) {
      await removeReaction(messageId, reactionId);
    }
  }
}
