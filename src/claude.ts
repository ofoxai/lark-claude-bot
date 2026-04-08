import { spawn } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const CHAT_LOGS_DIR = join(config.dataDir, "chat_logs");
mkdirSync(CHAT_LOGS_DIR, { recursive: true });

export interface ClaudeResult {
  output: string;
  timedOut: boolean;
  aborted?: boolean;
  sessionId?: string;
  /** Claude stop reason: end_turn / tool_use / max_tokens etc. */
  stopReason?: string;
  /** Actual number of turns executed */
  numTurns?: number;
  /** CLI exit code */
  exitCode?: number | null;
}

/** Registry of running Claude processes, used for external abort */
const runningProcesses = new Map<string, { kill: () => void; sessionId?: string }>();

/** Abort a running Claude process for the given chatId */
export function abortClaude(chatId: string): string | undefined {
  const entry = runningProcesses.get(chatId);
  if (!entry) return undefined;
  console.log(`[claude] Aborting process for ${chatId.slice(0, 12)}`);
  entry.kill();
  return entry.sessionId;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ClaudeOptions {
  sessionId?: string;
  timeoutMs?: number;
  cwd?: string;
  maxTurns?: number;
  logTag?: string;
  chatId?: string;
  /** Callback when Claude creates or updates a todo list */
  onTodoUpdate?: (todos: TodoItem[]) => void;
  /** Callback when Claude uses a tool (tool name + short summary) */
  onToolUse?: (toolName: string, summary: string) => void;
  /** Startup stall detection timeout (default 300_000 = 5 min) */
  startupTimeoutMs?: number;
}

/** Produce a short human-readable description of a tool call */
function summarizeToolUse(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return toolName;
  switch (toolName) {
    case "Read":
      return `Reading ${(input.file_path as string || "").split("/").pop()}`;
    case "Edit":
    case "Write":
      return `Editing ${(input.file_path as string || "").split("/").pop()}`;
    case "Bash":
      return `Running command`;
    case "Grep":
      return `Searching ${(input.pattern as string || "").slice(0, 30)}`;
    case "Glob":
      return `Finding files ${(input.pattern as string || "").slice(0, 30)}`;
    case "WebSearch":
      return `Searching: ${(input.query as string || "").slice(0, 30)}`;
    case "WebFetch":
      return `Fetching web page`;
    case "Agent":
      return `Subtask: ${(input.description as string || "").slice(0, 30)}`;
    default:
      return toolName;
  }
}

/**
 * Spawn Claude Code CLI (internal, single invocation).
 *
 * Uses --output-format stream-json for real-time progress events.
 * Activity-based idle timeout: resets on each output.
 * Startup stall detection: if no output within startupTimeoutMs, kills and flags.
 */
function spawnClaude(
  prompt: string,
  opts: ClaudeOptions = {}
): Promise<ClaudeResult & { startupStalled?: boolean }> {
  const {
    sessionId,
    timeoutMs = config.claude.defaultTimeoutMs,
    startupTimeoutMs = config.claude.startupTimeoutMs,
    cwd = config.claude.cwd,
    maxTurns = config.claude.defaultMaxTurns,
    logTag,
    onTodoUpdate,
    onToolUse,
    chatId,
  } = opts;

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(maxTurns),
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);

  return new Promise<ClaudeResult & { startupStalled?: boolean }>((resolve) => {
    let timedOut = false;
    let startupTimedOut = false;
    let aborted = false;
    let gotAnyOutput = false;
    let lineBuf = "";

    // Collected from stream events
    let resultOutput = "";
    let resultSessionId: string | undefined;
    let stopReason: string | undefined;
    let numTurns: number | undefined;

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

    // Register in process table for external abort
    if (chatId) {
      runningProcesses.set(chatId, {
        kill: () => { aborted = true; proc.kill("SIGTERM"); },
        sessionId,
      });
    }

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        gotAnyOutput = true;

        // Final result event
        if (event.type === "result") {
          resultOutput = typeof event.result === "string" ? event.result : "";
          resultSessionId = event.session_id;
          stopReason = event.stop_reason;
          numTurns = event.num_turns;
          return;
        }

        // Init event — capture session_id
        if (event.type === "system" && event.subtype === "init") {
          resultSessionId = event.session_id;
          if (chatId) {
            const entry = runningProcesses.get(chatId);
            if (entry) entry.sessionId = resultSessionId;
          }
          return;
        }

        // Tool use events — extract TodoWrite and other tools
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type !== "tool_use") continue;
            const toolName = block.name;

            // TodoWrite -> callback with todos
            if (toolName === "TodoWrite" && block.input?.todos && onTodoUpdate) {
              const todos: TodoItem[] = (block.input.todos as Array<Record<string, string>>).map(
                (t) => ({
                  content: t.content || "",
                  status: (t.status as TodoItem["status"]) || "pending",
                })
              );
              onTodoUpdate(todos);
            }

            // Notify caller about tool usage
            if (onToolUse && toolName !== "TodoWrite" && toolName !== "ToolSearch") {
              const summary = summarizeToolUse(toolName, block.input);
              onToolUse(toolName, summary);
            }
          }
        }

        // tool_use_result with updated todo state
        if (event.type === "user" && event.tool_use_result?.newTodos && onTodoUpdate) {
          try {
            const todos: TodoItem[] = (event.tool_use_result.newTodos as Array<Record<string, string>>).map(
              (t) => ({
                content: t.content || "",
                status: (t.status as TodoItem["status"]) || "pending",
              })
            );
            onTodoUpdate(todos);
          } catch { /* ignore malformed */ }
        }
      } catch {
        // Non-JSON line, ignore
      }
    }

    // Activity-based idle timeout: startup phase uses shorter timeout
    const IDLE_TIMEOUT = timeoutMs;
    let idleTimer = setTimeout(onIdle, startupTimeoutMs);

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      // After first output, switch to normal idle timeout
      idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);
    }

    function onIdle() {
      if (!gotAnyOutput) {
        console.log(`[claude] Startup timeout (${startupTimeoutMs / 1000}s no output), session=${sessionId || "new"}, killing`);
        startupTimedOut = true;
      } else {
        console.log(`[claude] Idle timeout (${IDLE_TIMEOUT / 1000}s no new output), killing`);
      }
      timedOut = true;
      proc.kill("SIGTERM");
    }

    proc.stdout.on("data", (data: Buffer) => {
      gotAnyOutput = true;
      resetIdleTimer();
      lineBuf += data.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() || "";
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr.on("data", () => {
      gotAnyOutput = true;
      resetIdleTimer();
    });

    proc.on("close", (code) => {
      clearTimeout(idleTimer);
      if (chatId) runningProcesses.delete(chatId);

      // Process remaining buffer
      if (lineBuf.trim()) processLine(lineBuf);

      const startupStalled = startupTimedOut;

      // Aborted sessions don't need empty-output handling
      if (!resultOutput && !timedOut && !aborted) {
        if (stopReason === "end_turn") {
          resultOutput = "";
        } else {
          const hints: string[] = [];
          if (stopReason === "tool_use") {
            hints.push(`max-turns exhausted (stop_reason=tool_use, num_turns=${numTurns})`);
          } else if (stopReason) {
            hints.push(`stop_reason: ${stopReason}`);
          }
          if (code !== 0) hints.push(`exit code: ${code}`);
          if (!gotAnyOutput) hints.push("stdout empty, CLI may not have started or auth expired");
          resultOutput = hints.length
            ? `❌ Claude session no output\n${hints.join("\n")}`
            : "";
        }
      }

      // Save log
      if (logTag) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const logFile = join(CHAT_LOGS_DIR, `${logTag}_${ts}.log`);
        const logContent = [
          `[${new Date().toISOString()}]`,
          `session: ${resultSessionId || "N/A"}`,
          `resumed: ${sessionId || "no"}`,
          `prompt: ${prompt.slice(0, 200)}`,
          `timedOut: ${timedOut}`,
          `aborted: ${aborted}`,
          `startupStalled: ${startupStalled}`,
          `---`,
          resultOutput,
        ].join("\n");
        try {
          appendFileSync(logFile, logContent, "utf-8");
        } catch { /* ignore */ }
      }

      resolve({
        output: resultOutput,
        timedOut: timedOut && !aborted,
        aborted,
        startupStalled,
        sessionId: resultSessionId,
        stopReason,
        numTurns,
        exitCode: code,
      });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(idleTimer);
      if (chatId) runningProcesses.delete(chatId);
      resolve({
        output: `Error launching claude: ${err.message}`,
        timedOut: false,
      });
    });
  });
}

/**
 * Run Claude CLI with auto-retry:
 * If startup stalls (no output within startupTimeoutMs), abandon session and retry once.
 */
export async function runClaude(
  prompt: string,
  opts: ClaudeOptions = {}
): Promise<ClaudeResult> {
  const result = await spawnClaude(prompt, opts);

  // If startup stalled while resuming a session, abandon session and retry
  if (result.startupStalled && opts.sessionId) {
    console.log(`[claude] Resume session stalled, abandoning session ${opts.sessionId}, starting fresh`);
    const retry = await spawnClaude(prompt, { ...opts, sessionId: undefined });
    return retry;
  }

  return result;
}

/**
 * Resume a completed session to get Claude to summarize what it did
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
