import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env file manually (no extra dependency)
const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    console.error(`Copy .env.example to .env and fill in your values`);
    process.exit(1);
  }
  return val;
}

export const config = {
  lark: {
    appId: required("LARK_APP_ID"),
    appSecret: required("LARK_APP_SECRET"),
    encryptKey: process.env.LARK_ENCRYPT_KEY || "",
  },
  bot: {
    name: process.env.BOT_NAME || "Marvin",
    adminOpenId: process.env.ADMIN_OPEN_ID || "",
  },
  claude: {
    cwd: process.env.CLAUDE_CWD || process.cwd(),
    defaultTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS) || 600_000,
    defaultMaxTurns: Number(process.env.CLAUDE_MAX_TURNS) || 200,
    startupTimeoutMs: Number(process.env.CLAUDE_STARTUP_TIMEOUT_MS) || 300_000,
    idleTimeoutMs: Number(process.env.CLAUDE_IDLE_TIMEOUT_MS) || 3_600_000,
  },
  dataDir: resolve(__dirname, "../data"),
  memoryDir: resolve(__dirname, "../data/memory"),
  chatContextDir: resolve(__dirname, "../data/chat_context"),
  tasksFile: resolve(__dirname, "../data/tasks.json"),
  taskLogsDir: resolve(__dirname, "../data/task_logs"),
};
