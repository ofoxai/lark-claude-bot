/**
 * 记忆系统 — 基于 Claude Code 自身 memory 能力
 *
 * 设计思路：
 * - 不自己维护记忆文件，而是在每次对话的 prompt 中注入"记忆更新"指令
 * - Claude Code 自带 memory 系统（~/.claude/projects/ 下的 MEMORY.md），
 *   让它自己判断是否有值得记住的信息
 * - 我们只维护轻量的对话日志（用于构建上下文）
 *
 * 保留的功能：
 * - 对话日志（最近 N 轮，用于给 Claude 提供对话上下文）
 * - 群消息缓存（当前群最近的消息，按需加载）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

mkdirSync(config.memoryDir, { recursive: true });
mkdirSync(config.chatContextDir, { recursive: true });

const DIALOGS_FILE = join(config.memoryDir, "dialogs.json");
const MAX_DIALOGS = 50;

// ==================== Dialog Log ====================

export interface DialogEntry {
  chatId: string;
  chatName: string;
  sender: string;
  prompt: string;
  response: string;
  timestamp: string;
}

function loadDialogs(): DialogEntry[] {
  if (!existsSync(DIALOGS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DIALOGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDialogs(dialogs: DialogEntry[]): void {
  const tmp = DIALOGS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(dialogs, null, 2), "utf-8");
  renameSync(tmp, DIALOGS_FILE);
}

export function addDialog(entry: DialogEntry): void {
  const dialogs = loadDialogs();
  dialogs.push(entry);
  if (dialogs.length > MAX_DIALOGS) {
    dialogs.splice(0, dialogs.length - MAX_DIALOGS);
  }
  saveDialogs(dialogs);
}

export function getRecentDialogs(chatId?: string, limit = 10): DialogEntry[] {
  const dialogs = loadDialogs();
  const filtered = chatId
    ? dialogs.filter((d) => d.chatId === chatId)
    : dialogs;
  return filtered.slice(-limit);
}

// ==================== Chat Context ====================

export function saveChatContext(
  chatId: string,
  chatName: string,
  messages: string
): void {
  const file = join(config.chatContextDir, `${chatId}.md`);
  writeFileSync(
    file,
    `# ${chatName}\nUpdated: ${new Date().toISOString()}\n\n${messages}`,
    "utf-8"
  );
}

export function readChatContext(chatId: string): string {
  const file = join(config.chatContextDir, `${chatId}.md`);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf-8");
}

// ==================== Build Prompt Context ====================

/**
 * 构建给 Claude 的上下文片段（对话历史）
 */
export function buildDialogContext(chatId: string): string {
  const recent = getRecentDialogs(chatId, 5);
  if (!recent.length) return "";

  return (
    "## 近期对话记录\n" +
    recent
      .map(
        (d) =>
          `[${d.timestamp.slice(5, 16)}] ${d.sender}: ${d.prompt.slice(0, 100)}\n→ ${d.response.slice(0, 200)}`
      )
      .join("\n\n")
  );
}

/**
 * 附加在 Claude 回复结束后的记忆更新指令
 */
export const MEMORY_UPDATE_SUFFIX = `

---
任务结束后，请检查这次对话是否有值得更新记忆的信息（如用户偏好、项目进展、重要决策等）。
如果有，请更新你的 memory。如果没有，不需要做任何操作。`;
