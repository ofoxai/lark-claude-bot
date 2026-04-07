/**
 * 手动触发定时任务
 * 用法: npx tsx src/trigger.ts <task_id>
 */

import { loadTasks } from "./scheduler.js";
import { executeTask } from "./taskExecutor.js";

const taskId = process.argv[2];
if (!taskId) {
  const tasks = loadTasks().filter((t) => t.status !== "deleted");
  console.log("用法: npx tsx src/trigger.ts <task_id>\n");
  console.log("可用任务:");
  for (const t of tasks) {
    console.log(`  ${t.id}  ${t.name}  (${t.cron}) [${t.status}]`);
  }
  process.exit(0);
}

const tasks = loadTasks();
const task = tasks.find((t) => t.id === taskId);
if (!task) {
  console.error(`Task not found: ${taskId}`);
  process.exit(1);
}

console.log(`Triggering: ${task.name} (${task.id})`);
console.log(`Prompt: ${task.prompt.slice(0, 100)}...`);
console.log(`Chat: ${task.chatName} (${task.chatId})`);
console.log("---");

executeTask(task)
  .then(() => {
    console.log("\nTask completed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nTask failed:", err);
    process.exit(1);
  });
