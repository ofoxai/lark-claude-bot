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
  mentions?: Array<{ key: string; name: string; id?: { open_id?: string } }>;
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

  // 建立 messageId → 消息 的索引，用于渲染回复关系
  const msgIndex = new Map<string, StoredMessage>();
  for (const m of messages) msgIndex.set(m.messageId, m);

  // 从所有消息的 mentions 里积累 open_id → name 映射
  const nameMap = new Map<string, string>();
  for (const m of messages) {
    if (!m.mentions?.length) continue;
    for (const mention of m.mentions) {
      const openId = mention.id?.open_id;
      if (openId && mention.name) nameMap.set(openId, mention.name);
    }
  }

  // 记录原始窗口内的 messageId，用于后续判断回复目标是否在可见范围内
  const windowIds = new Set(messages.map((m) => m.messageId));

  // 如果被回复的消息不在最近 N 条里，额外加载更多来查找
  const parentIdSet = new Set(
    messages
      .filter((m) => m.parentId && !msgIndex.has(m.parentId))
      .map((m) => m.parentId!)
  );
  if (parentIdSet.size) {
    const allMessages = getRecentMessages(chatId, 200);
    for (const m of allMessages) {
      if (parentIdSet.has(m.messageId) && !msgIndex.has(m.messageId)) {
        msgIndex.set(m.messageId, m);
      }
      if (m.mentions?.length) {
        for (const mention of m.mentions) {
          const openId = mention.id?.open_id;
          if (openId && mention.name) nameMap.set(openId, mention.name);
        }
      }
    }
  }

  const senderName = (id: string): string => nameMap.get(id) || id.slice(0, 8);

  const lines = messages.map((m) => {
    const time = m.timestamp.slice(11, 16); // HH:MM
    const sender = senderName(m.senderId);
    const thread = m.rootId ? ` [话题:${m.rootId.slice(-8)}]` : "";

    // 将 @_user_N 占位符替换为真实名字
    const resolveMentions = (text: string): string => {
      if (!m.mentions?.length) return text;
      let result = text;
      for (const mention of m.mentions) {
        result = result.replace(new RegExp(mention.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `@${mention.name}`);
      }
      return result;
    };

    // 如果是回复消息，附上被回复消息的摘要
    let replyCtx = "";
    if (m.parentId) {
      const parent = msgIndex.get(m.parentId);
      if (parent) {
        const inWindow = windowIds.has(m.parentId!);
        const previewLimit = inWindow ? 80 : 300;
        let parentText = "";
        let parentPreview = "";
        try {
          if (parent.msgType === "text") {
            parentText = JSON.parse(parent.content).text || "";
            parentPreview = parentText.slice(0, previewLimit);
          } else if (parent.msgType === "post") {
            const obj = JSON.parse(parent.content);
            const parts: string[] = [];
            if (obj.title) parts.push(obj.title);
            for (const line of obj.content || []) {
              if (!Array.isArray(line)) continue;
              for (const item of line) {
                if (item.tag === "text" && item.text) parts.push(item.text.trim());
                else if (item.tag === "a" && item.text) parts.push(item.text.trim());
              }
            }
            parentText = parts.join(" ");
            parentPreview = parentText.slice(0, previewLimit);
          }
        } catch { /* ignore */ }
        if (parentPreview) {
          const ellipsis = parentText.length > previewLimit ? "…" : "";
          replyCtx = ` [回复 ${senderName(parent.senderId)}: "${parentPreview}${ellipsis}"]`;
        }
      }
    }

    switch (m.msgType) {
      case "text": {
        try {
          const raw = JSON.parse(m.content).text || "";
          const text = resolveMentions(raw).slice(0, 200);
          return `[${time}] ${sender}${thread}${replyCtx}: ${text}`;
        } catch {
          return `[${time}] ${sender}${thread}${replyCtx}: ${m.content}`;
        }
      }
      case "image":
        return `[${time}] ${sender}${thread}${replyCtx}: [图片 image_key=${m.imageKey}]`;
      case "file":
        return `[${time}] ${sender}${thread}${replyCtx}: [文件 ${m.fileName || m.fileKey}]`;
      case "post": {
        try {
          const obj = JSON.parse(m.content);
          const parts: string[] = [];
          if (obj.title) parts.push(obj.title);
          for (const line of obj.content || []) {
            if (!Array.isArray(line)) continue;
            for (const item of line) {
              if (item.tag === "text" && item.text) parts.push(item.text.trim());
              else if (item.tag === "a" && item.text) parts.push(item.text.trim());
              else if (item.tag === "img" && item.image_key) parts.push(`[图片 image_key=${item.image_key}]`);
            }
          }
          const text = resolveMentions(parts.join(" ").replace(/\s+/g, " ")).slice(0, 300);
          return `[${time}] ${sender}${thread}${replyCtx}: ${text || "[富文本消息]"}`;
        } catch {
          return `[${time}] ${sender}${thread}${replyCtx}: [富文本消息]`;
        }
      }
      default:
        return `[${time}] ${sender}${thread}${replyCtx}: [${m.msgType}消息]`;
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
