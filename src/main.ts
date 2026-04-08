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

function main() {
  console.log("=".repeat(50));
  console.log(`  ${config.bot.name} — Lark Bot (WebSocket)`);
  console.log("=".repeat(50));
  console.log(`  App ID: ${config.lark.appId.slice(0, 8)}...`);
  console.log(`  Domain: Lark (international)`);
  console.log(`  Mode:   WebSocket (长连接)`);
  console.log("=".repeat(50));

  const wsClient = new lark.WSClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    loggerLevel: lark.LoggerLevel.info,
    domain: lark.Domain.Lark,
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
