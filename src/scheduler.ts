/**
 * Cron 调度器
 *
 * 每 60 秒检查一次 tasks.json，匹配 cron 表达式触发任务。
 * tasks.json 每次从磁盘读取，手动编辑立即生效。
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { config } from "./config.js";
import { executeTask } from "./taskExecutor.js";

// ==================== 数据模型 ====================

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  jitterMinutes: number;
  chatId: string;
  chatName: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "paused" | "deleted";
  timeoutMs: number;
  maxRetries: number;
  lastRun?: {
    startedAt: string;
    finishedAt: string;
    success: boolean;
    durationMs: number;
  };
}

interface TasksFile {
  version: number;
  tasks: ScheduledTask[];
}

// ==================== 任务持久化 ====================

export function loadTasks(): ScheduledTask[] {
  if (!existsSync(config.tasksFile)) return [];
  try {
    const data: TasksFile = JSON.parse(readFileSync(config.tasksFile, "utf-8"));
    return data.tasks || [];
  } catch {
    console.error("[scheduler] Failed to parse tasks.json");
    return [];
  }
}

export function saveTasks(tasks: ScheduledTask[]): void {
  const data: TasksFile = { version: 1, tasks };
  const tmp = config.tasksFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, config.tasksFile);
}

export function updateTaskLastRun(
  taskId: string,
  lastRun: ScheduledTask["lastRun"]
): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (task) {
    task.lastRun = lastRun;
    saveTasks(tasks);
  }
}

// ==================== Cron 匹配 ====================

function fieldMatches(field: string, value: number, isWeekday = false): boolean {
  if (field === "*") return true;

  // */N 步进
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    return value % step === 0;
  }

  // 逗号分隔 1,3,5
  if (field.includes(",")) {
    const allowed = field.split(",").map(Number);
    if (isWeekday) {
      // 周日兼容：0 和 7 都表示周日
      if (allowed.includes(7)) allowed.push(0);
      if (allowed.includes(0)) allowed.push(7);
    }
    return allowed.includes(value);
  }

  // 范围 1-5
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return value >= lo && value <= hi;
  }

  // 单个数字
  const expected = parseInt(field);
  if (isWeekday && expected === 7) return value === 0;
  return value === expected;
}

export function cronMatches(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dom, month, dow] = parts;
  const weekday = now.getDay(); // 0=Sun, 1=Mon...6=Sat

  return (
    fieldMatches(minute, now.getMinutes()) &&
    fieldMatches(hour, now.getHours()) &&
    fieldMatches(dom, now.getDate()) &&
    fieldMatches(month, now.getMonth() + 1) &&
    fieldMatches(dow, weekday, true)
  );
}

// ==================== 执行锁 ====================

const locks = new Map<string, { startedAt: Date }>();
const lastTriggerMinute = new Map<string, string>();

function isLocked(taskId: string): boolean {
  return locks.has(taskId);
}

export function acquireLock(taskId: string): void {
  locks.set(taskId, { startedAt: new Date() });
}

export function releaseLock(taskId: string): void {
  locks.delete(taskId);
}

function ranThisMinute(task: ScheduledTask, now: Date): boolean {
  const key = `${now.getHours()}:${now.getMinutes()}`;
  if (lastTriggerMinute.get(task.id) === key) return true;
  lastTriggerMinute.set(task.id, key);
  return false;
}

// ==================== 调度循环 ====================

function tick(): void {
  const tasks = loadTasks();
  const now = new Date();

  for (const task of tasks) {
    if (task.status !== "active") continue;
    if (!cronMatches(task.cron, now)) continue;
    if (isLocked(task.id)) continue;
    if (ranThisMinute(task, now)) continue;

    const jitterMs = Math.random() * task.jitterMinutes * 60_000;
    console.log(
      `[scheduler] ${task.name} matched, executing in ${Math.round(jitterMs / 1000)}s`
    );

    setTimeout(() => {
      executeTask(task).catch((err) =>
        console.error(`[scheduler] Task ${task.id} failed:`, err)
      );
    }, jitterMs);
  }
}

let intervalId: ReturnType<typeof setInterval> | undefined;

export function startScheduler(): void {
  console.log("[scheduler] Started (60s tick)");
  // 第一次 tick 延迟 5 秒（等服务初始化完成）
  setTimeout(tick, 5_000);
  intervalId = setInterval(tick, 60_000);
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = undefined;
    console.log("[scheduler] Stopped");
  }
}
