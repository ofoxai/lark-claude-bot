import * as lark from "@larksuiteoapi/node-sdk";
import { config } from "./config.js";
import { handleMessage, resumeInterruptedSessions } from "./handler.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

/**
 * lark-claude-bot — Lark Bot (WebSocket mode)
 *
 * No public IP needed — SDK maintains a persistent connection.
 * Events arrive → EventDispatcher routes → handleMessage processes async
 */

const eventDispatcher = new lark.EventDispatcher({
  encryptKey: config.lark.encryptKey || undefined,
}).register({
  "im.message.receive_v1": async (data) => {
    console.log("[event] Received im.message.receive_v1:", JSON.stringify(data).slice(0, 1000));
    handleMessage(data as unknown as Record<string, unknown>).catch((err) =>
      console.error("[event] Unhandled error in handleMessage:", err)
    );
  },
});

const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_BACKOFF_MS = 3 * 60 * 1000; // 3 minutes before exit

function safeStringify(msg: unknown[]): string {
  try {
    return JSON.stringify(msg);
  } catch {
    return msg.map((m) => (typeof m === "string" ? m : String(m))).join(" ");
  }
}

function makeWsLogger() {
  let consecutiveFailures = 0;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    error: (...msg: unknown[]) => {
      console.error("[error]:", msg);
      const msgStr = safeStringify(msg);
      const isSystemBusy = msgStr.includes("system busy");
      if (isSystemBusy && !exitTimer) {
        consecutiveFailures++;
        console.warn(
          `[ws] consecutive connection failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            `[ws] too many failures, waiting ${FAILURE_BACKOFF_MS / 1000}s then exiting for pm2 restart`
          );
          exitTimer = setTimeout(() => process.exit(1), FAILURE_BACKOFF_MS);
        }
      }
    },
    warn: (...msg: unknown[]) => console.warn("[warn]:", msg),
    info: (...msg: unknown[]) => {
      console.info("[info]:", msg);
      const isReady = safeStringify(msg).includes("ws client ready");
      if (isReady) {
        consecutiveFailures = 0;
        if (exitTimer) {
          clearTimeout(exitTimer);
          exitTimer = undefined;
          console.log("[ws] connection recovered, cancelled scheduled exit");
        }
      }
    },
    debug: (...msg: unknown[]) => console.debug("[debug]:", msg),
    trace: (...msg: unknown[]) => console.trace("[trace]:", msg),
  };
}

function main() {
  console.log("=".repeat(50));
  console.log(`  ${config.bot.name} — Lark Bot (WebSocket)`);
  console.log("=".repeat(50));
  console.log(`  App ID: ${config.lark.appId.slice(0, 8)}...`);
  const domain = process.env.LARK_DOMAIN === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;
  const domainLabel = process.env.LARK_DOMAIN === "feishu" ? "Feishu (domestic)" : "Lark (international)";
  console.log(`  Domain: ${domainLabel}`);
  console.log(`  Mode:   WebSocket (长连接)`);
  console.log("=".repeat(50));

  const wsClient = new lark.WSClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    loggerLevel: lark.LoggerLevel.info,
    logger: makeWsLogger(),
    domain,
  });

  wsClient.start({ eventDispatcher });
  console.log("[ws] Connecting to Lark WebSocket...");

  // Start scheduled task scheduler
  startScheduler();

  // Resume interrupted active sessions (delay 5s for WebSocket to be ready)
  setTimeout(() => resumeInterruptedSessions(), 5000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[shutdown] Stopping...");
    stopScheduler();
    wsClient.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
