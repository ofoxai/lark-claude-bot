/**
 * 定时任务管理 — 上下文注入
 *
 * 不做正则意图检测。把任务列表和可用操作注入到 Claude 的 prompt 中，
 * 让 Claude 自行判断用户意图并通过编辑 tasks.json 来执行操作。
 *
 * Claude 可以：
 * - 查看任务列表（直接读 tasks.json）
 * - 创建/修改/暂停/删除任务（编辑 tasks.json）
 * - 立即执行某个任务的 prompt（直接执行，不需要等 cron）
 */

import { readFileSync, existsSync } from "fs";
import { config } from "./config.js";
import { type ScheduledTask } from "./scheduler.js";

/**
 * 构建任务上下文，注入到 Claude 的 prompt 中
 * Claude 看到这个上下文后，自己决定要不要操作任务
 */
export function buildTaskContext(chatId: string): string {
  if (!existsSync(config.tasksFile)) return "";

  let tasks: ScheduledTask[] = [];
  try {
    const data = JSON.parse(readFileSync(config.tasksFile, "utf-8"));
    tasks = (data.tasks || []).filter(
      (t: ScheduledTask) => t.status !== "deleted"
    );
  } catch {
    return "";
  }

  if (!tasks.length) return "";

  // 当前群的任务
  const chatTasks = tasks.filter((t) => t.chatId === chatId);
  // 其他群的任务（只显示名称，不显示详情）
  const otherTasks = tasks.filter((t) => t.chatId !== chatId);

  const lines: string[] = ["## 定时任务系统"];
  lines.push("");
  lines.push("你可以管理定时任务。任务配置文件在 `data/tasks.json`。");
  lines.push("");
  lines.push("**可用操作：**");
  lines.push("- 查看任务：直接读 `data/tasks.json`");
  lines.push("- 创建任务：在 tasks.json 的 tasks 数组中添加新条目（需要 id, name, prompt, cron, chatId 等字段）");
  lines.push("- 修改任务：编辑 tasks.json 中对应任务的字段");
  lines.push("- 暂停/恢复：修改 status 为 paused 或 active");
  lines.push("- 删除任务：修改 status 为 deleted");
  lines.push("- **立即执行**：如果用户要求立即运行某个任务，直接按该任务的 prompt 执行，不需要修改 tasks.json");
  lines.push("");

  if (chatTasks.length) {
    lines.push(`### 当前群的任务（${chatTasks.length} 个）`);
    for (const t of chatTasks) {
      const lastRun = t.lastRun
        ? `上次: ${t.lastRun.finishedAt?.slice(0, 16) || "N/A"} ${t.lastRun.success ? "✅" : "❌"}`
        : "未执行过";
      lines.push(`- **${t.name}** (\`${t.id}\`) | cron: \`${t.cron}\` | ${t.status === "active" ? "✅" : "⏸️"} | ${lastRun}`);
    }
    lines.push("");
  }

  if (otherTasks.length) {
    lines.push(`### 其他群的任务（${otherTasks.length} 个）`);
    for (const t of otherTasks) {
      lines.push(`- ${t.name} (\`${t.id}\`) | ${t.chatName}`);
    }
    lines.push("");
  }

  lines.push("**注意：** 新建任务时 chatId 用 `" + chatId + "`，chatName 用当前群名。");

  return lines.join("\n");
}
