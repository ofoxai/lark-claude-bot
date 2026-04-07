import { spawn } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const CHAT_LOGS_DIR = join(config.dataDir, "chat_logs");
mkdirSync(CHAT_LOGS_DIR, { recursive: true });

export interface ClaudeResult {
  output: string;
  timedOut: boolean;
  sessionId?: string;
  /** Claude 停止原因：end_turn / tool_use / max_tokens 等 */
  stopReason?: string;
  /** 实际执行的 turn 数 */
  numTurns?: number;
  /** CLI exit code */
  exitCode?: number | null;
}

export interface ClaudeOptions {
  sessionId?: string;
  timeoutMs?: number;   // 默认 600_000 (10 min)
  cwd?: string;
  maxTurns?: number;    // --max-turns，默认 200
  logTag?: string;      // 日志标签（如 chatId），用于保存完整输出
}

/**
 * 调用本机 Claude Code CLI
 *
 * 使用 --output-format json 获取结构化输出（含 session_id）
 * 完整输出保存到 data/chat_logs/
 */
export async function runClaude(
  prompt: string,
  opts: ClaudeOptions = {}
): Promise<ClaudeResult> {
  const {
    sessionId,
    timeoutMs = config.claude.defaultTimeoutMs,
    cwd = config.claude.cwd,
    maxTurns = config.claude.defaultMaxTurns,
    logTag,
  } = opts;

  const args = [
    "--print",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(maxTurns),
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);

  return new Promise<ClaudeResult>((resolve) => {
    const chunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;

    const env = { ...process.env };
    const localBin = `${process.env.HOME}/.local/bin`;
    if (!env.PATH?.includes(localBin)) {
      env.PATH = `${localBin}:${env.PATH}`;
    }

    const proc = spawn("claude", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => {
      chunks.push(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);

      const rawOutput = chunks.join("").trim();
      const stderrOutput = stderrChunks.join("").trim();
      let output = rawOutput;
      let resultSessionId: string | undefined;
      let stopReason: string | undefined;
      let numTurns: number | undefined;

      // 解析 JSON 输出
      try {
        const parsed = JSON.parse(rawOutput);
        resultSessionId = parsed.session_id;
        stopReason = parsed.stop_reason;
        numTurns = parsed.num_turns;
        if (typeof parsed.result === "string") {
          output = parsed.result;
        } else {
          output = "";
        }
      } catch {
        if (rawOutput.startsWith('{"type":')) {
          // JSON 被截断（通常是超时 kill 导致）
          // 尝试提取部分有用信息而不是清空
          if (timedOut) {
            output = `[超时截断] 原始输出前 3000 字符:\n${rawOutput.slice(0, 3000)}`;
          } else {
            output = "";
          }
        } else {
          output = rawOutput;
        }
      }

      // 空输出处理
      if (!output && !timedOut) {
        if (stopReason === "end_turn") {
          // Claude 正常结束但没生成文本——执行了工具操作但没总结
          // 留空，让调用方通过 resumeSummary() 获取总结
          output = "";
        } else {
          // 真正的异常情况才输出诊断
          const hints: string[] = [];
          if (stopReason === "tool_use") {
            hints.push(`max-turns 耗尽 (stop_reason=tool_use, num_turns=${numTurns})`);
          } else if (stopReason) {
            hints.push(`stop_reason: ${stopReason}`);
          }
          if (code !== 0) hints.push(`exit code: ${code}`);
          if (!rawOutput) hints.push("stdout 为空，CLI 可能未启动或登录态过期");
          if (stderrOutput && !stderrOutput.startsWith("{")) {
            hints.push(`stderr: ${stderrOutput.slice(0, 500)}`);
          }
          if (/login|auth|token|expired/i.test(stderrOutput + rawOutput)) {
            hints.push("疑似 Claude CLI 登录态过期");
          }
          output = `❌ Claude session 无输出\n${hints.join("\n") || "原因未知"}`;
        }
      }

      // 保存完整日志
      if (logTag) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const logFile = join(CHAT_LOGS_DIR, `${logTag}_${ts}.log`);
        const logContent = [
          `[${new Date().toISOString()}]`,
          `session: ${resultSessionId || "N/A"}`,
          `prompt: ${prompt.slice(0, 200)}`,
          `timedOut: ${timedOut}`,
          `---`,
          output,
        ].join("\n");
        try {
          appendFileSync(logFile, logContent, "utf-8");
        } catch { /* ignore */ }
      }

      resolve({
        output,
        timedOut,
        sessionId: resultSessionId,
        stopReason,
        numTurns,
        exitCode: code,
      });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        output: `Error launching claude: ${err.message}`,
        timedOut: false,
      });
    });
  });
}

/**
 * Resume 一个已完成的 session，让 Claude 总结刚才做了什么
 */
export async function resumeSummary(
  sessionId: string,
  timeoutMs = 30_000
): Promise<string> {
  const env = { ...process.env };
  const localBin = `${process.env.HOME}/.local/bin`;
  if (!env.PATH?.includes(localBin)) {
    env.PATH = `${localBin}:${env.PATH}`;
  }

  return new Promise<string>((resolve) => {
    const chunks: string[] = [];
    const proc = spawn("claude", [
      "--print", "--output-format", "json",
      "--max-turns", "1",
      "--resume", sessionId,
      "用一两句话简要总结你刚才完成的操作和结果，直接说结论，不要说废话。",
    ], {
      cwd: config.claude.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    const timer = setTimeout(() => { proc.kill("SIGTERM"); resolve(""); }, timeoutMs);

    proc.on("close", () => {
      clearTimeout(timer);
      const raw = chunks.join("").trim();
      try {
        const parsed = JSON.parse(raw);
        resolve(typeof parsed.result === "string" ? parsed.result : "");
      } catch {
        resolve("");
      }
    });
    proc.on("error", () => { clearTimeout(timer); resolve(""); });
  });
}
