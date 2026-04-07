/**
 * 群消息本地存储
 *
 * 所有收到的群消息都存一份到本地，包括非 @机器人 的消息。
 * 这样 @机器人 时可以直接从本地读取完整上下文（图片、文件、前后对话），
 * 零 API 调用，无时间窗口限制。
 *
 * 存储结构：data/chat_messages/{chatId}.jsonl（每行一条消息，追加写入）
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const STORE_DIR = join(config.dataDir, "chat_messages");
mkdirSync(STORE_DIR, { recursive: true });

export interface StoredMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  senderType: string;
  msgType: string;
  content: string;
  mentions?: Array<{ key: string; name: string }>;
  timestamp: string;
  // 话题（Thread）
  rootId?: string;    // 话题根消息 ID
  parentId?: string;  // 直接回复的消息 ID
  threadId?: string;  // 话题 ID
  // 媒体资源
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
}

/** 从事件数据中提取并存储消息 */
export function storeMessage(data: Record<string, unknown>): StoredMessage | null {
  const message = data.message as Record<string, unknown>;
  if (!message) return null;

  const msgType = message.message_type as string;
  const content = (message.content as string) || "{}";
  const sender = data.sender as Record<string, unknown> | undefined;
  const senderIdObj = sender?.sender_id as Record<string, unknown> | undefined;

  // create_time 是毫秒时间戳（如 "1774611366200"）
  const createTimeMs = Number(message.create_time as string);
  const ts = createTimeMs > 1e12
    ? new Date(createTimeMs).toISOString()        // 已经是毫秒
    : createTimeMs > 1e9
      ? new Date(createTimeMs * 1000).toISOString() // 是秒，需要 *1000
      : new Date().toISOString();                    // 无效值，用当前时间

  const stored: StoredMessage = {
    messageId: message.message_id as string,
    chatId: message.chat_id as string,
    chatType: message.chat_type as string,
    senderId: senderIdObj?.open_id as string || "unknown",
    senderType: sender?.sender_type as string || "user",
    msgType,
    content,
    mentions: message.mentions as StoredMessage["mentions"],
    timestamp: ts,
    // 话题字段
    rootId: message.root_id as string | undefined,
    parentId: message.parent_id as string | undefined,
    threadId: message.thread_id as string | undefined,
  };

  // 提取媒体资源信息
  try {
    const parsed = JSON.parse(content);
    if (msgType === "image") {
      stored.imageKey = parsed.image_key;
    } else if (msgType === "file") {
      stored.fileKey = parsed.file_key;
      stored.fileName = parsed.file_name;
    }
  } catch { /* ignore */ }

  // 追加写入 JSONL 文件
  const file = join(STORE_DIR, `${stored.chatId}.jsonl`);
  appendFileSync(file, JSON.stringify(stored) + "\n", "utf-8");

  return stored;
}

/** 读取群最近 N 条消息 */
export function getRecentMessages(chatId: string, limit = 20): StoredMessage[] {
  const file = join(STORE_DIR, `${chatId}.jsonl`);
  if (!existsSync(file)) return [];

  const raw = readFileSync(file, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  const recent = lines.slice(-limit);
  const messages: StoredMessage[] = [];
  for (const line of recent) {
    try {
      messages.push(JSON.parse(line));
    } catch { /* skip corrupted lines */ }
  }
  return messages;
}

/** 构建群上下文文本（供 Claude 使用） */
export function buildChatContext(chatId: string, limit = 20): string {
  const messages = getRecentMessages(chatId, limit);
  if (!messages.length) return "";

  const lines = messages.map((m) => {
    const time = m.timestamp.slice(11, 16); // HH:MM
    const sender = m.senderId.slice(0, 8);
    const thread = m.rootId ? ` [话题:${m.rootId.slice(-8)}]` : "";

    switch (m.msgType) {
      case "text": {
        try {
          const text = JSON.parse(m.content).text || "";
          return `[${time}] ${sender}${thread}: ${text}`;
        } catch {
          return `[${time}] ${sender}${thread}: ${m.content}`;
        }
      }
      case "image":
        return `[${time}] ${sender}${thread}: [图片 image_key=${m.imageKey}]`;
      case "file":
        return `[${time}] ${sender}${thread}: [文件 ${m.fileName || m.fileKey}]`;
      case "post":
        return `[${time}] ${sender}${thread}: [富文本消息]`;
      default:
        return `[${time}] ${sender}${thread}: [${m.msgType}消息]`;
    }
  });

  return "## 群最近消息\n" + lines.join("\n");
}

/** 查找最近的媒体消息（图片/文件） */
export function findRecentMedia(
  chatId: string,
  type: "image" | "file",
  limit = 5
): StoredMessage[] {
  const messages = getRecentMessages(chatId, 50);
  return messages
    .filter((m) => m.msgType === type)
    .slice(-limit);
}
