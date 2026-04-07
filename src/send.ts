import { sendCard, sendText } from "./lark.js";

const chatId = process.argv[2];
const message = process.argv[3];
const mode = process.argv[4] || "card";

if (!chatId || !message) {
  console.log("Usage: npx tsx src/send.ts <chatId> <message> [card|text]");
  process.exit(1);
}

if (mode === "text") {
  await sendText(chatId, message);
} else {
  await sendCard(chatId, message);
}
console.log("Sent.");
process.exit(0);
