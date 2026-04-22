import * as lark from "@larksuiteoapi/node-sdk";
import fs from "fs";
import { config } from "./config.js";

// Lark Client — SDK manages token automatically
// Supports LARK_DOMAIN=feishu for domestic Feishu tenants
const domain = process.env.LARK_DOMAIN === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;
export const client = new lark.Client({
  appId: config.lark.appId,
  appSecret: config.lark.appSecret,
  domain,
  loggerLevel: lark.LoggerLevel.info,
});

// ==================== Message dedup ====================
const processedMsgIds = new Set<string>();
const MAX_DEDUP = 5000;

export function isDuplicate(messageId: string): boolean {
  if (processedMsgIds.has(messageId)) return true;
  if (processedMsgIds.size > MAX_DEDUP) {
    const arr = [...processedMsgIds];
    for (let i = 0; i < arr.length / 2; i++) processedMsgIds.delete(arr[i]);
  }
  processedMsgIds.add(messageId);
  return false;
}

// ==================== Send messages ====================

export async function sendText(
  chatId: string,
  text: string,
  replyTo?: string
): Promise<void> {
  const MAX = 3800;
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt < MAX / 2) splitAt = MAX;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (let i = 0; i < parts.length; i++) {
    const content = JSON.stringify({ text: parts[i] });
    if (i === 0 && replyTo) {
      await client.im.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: "text", content },
      });
    } else {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content },
      });
    }
    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** Count tables in markdown (consecutive lines starting with |) */
function countTables(text: string): number {
  let count = 0;
  let inTable = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|")) {
      if (!inTable) {
        count++;
        inTable = true;
      }
    } else {
      inTable = false;
    }
  }
  return count;
}

/**
 * Send an updatable progress card, returns message_id for subsequent patches
 */
export async function sendProgressCard(
  chatId: string,
  markdown: string,
  replyTo?: string
): Promise<string | undefined> {
  const card = {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      elements: [{ tag: "markdown", content: markdown }],
    },
  };
  const content = JSON.stringify(card);
  try {
    let resp;
    if (replyTo) {
      resp = await client.im.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: "interactive", content },
      });
    } else {
      resp = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content },
      });
    }
    return (resp?.data as Record<string, string> | undefined)?.message_id;
  } catch (err) {
    console.error("[lark] sendProgressCard failed:", (err as Error).message);
    return undefined;
  }
}

/**
 * Update an existing progress card's content
 */
export async function updateProgressCard(
  messageId: string,
  markdown: string
): Promise<boolean> {
  const card = {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      elements: [{ tag: "markdown", content: markdown }],
    },
  };
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    return true;
  } catch (err) {
    console.error("[lark] updateProgressCard failed:", (err as Error).message);
    return false;
  }
}

export async function sendCard(
  chatId: string,
  markdown: string,
  title?: string,
  replyTo?: string
): Promise<void> {

  const card: Record<string, unknown> = {
    schema: "2.0",
    body: {
      direction: "vertical",
      elements: [{ tag: "markdown", content: markdown }],
    },
  };
  if (title) {
    card.header = {
      title: { tag: "plain_text", content: title },
      template: "blue",
    };
  }

  const content = JSON.stringify(card);

  // Split long markdown into segments to avoid card limits
  const MAX_CARD = 3500;
  const MAX_TABLES = 5;
  const segments: string[] = [];
  let remaining = markdown;
  while (remaining.length > 0) {
    const needsSplit = remaining.length > MAX_CARD || countTables(remaining) > MAX_TABLES;
    if (!needsSplit) {
      segments.push(remaining);
      break;
    }
    let splitAt = -1;
    const searchLimit = remaining.length > MAX_CARD ? MAX_CARD : remaining.length;
    const doubleNl = remaining.lastIndexOf("\n\n", searchLimit);
    if (doubleNl >= searchLimit / 3) {
      splitAt = doubleNl + 1;
    } else {
      let candidate = remaining.lastIndexOf("\n", searchLimit);
      while (candidate > searchLimit / 3) {
        const nextChar = remaining[candidate + 1];
        if (nextChar === "|" || (nextChar === "-" && remaining[candidate + 2] === "-")) {
          candidate = remaining.lastIndexOf("\n", candidate - 1);
        } else {
          break;
        }
      }
      if (candidate >= searchLimit / 3) {
        splitAt = candidate;
      } else {
        splitAt = searchLimit;
      }
    }
    let candidate = remaining.slice(0, splitAt);
    while (countTables(candidate) > MAX_TABLES && splitAt > 0) {
      const earlier = remaining.lastIndexOf("\n\n", splitAt - 2);
      if (earlier <= 0) break;
      splitAt = earlier + 1;
      candidate = remaining.slice(0, splitAt);
    }
    segments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (let i = 0; i < segments.length; i++) {
    const segCard: Record<string, unknown> = {
      schema: "2.0",
      body: {
        direction: "vertical",
        elements: [{ tag: "markdown", content: segments[i] }],
      },
    };
    if (i === 0 && title) {
      segCard.header = {
        title: { tag: "plain_text", content: title },
        template: "blue",
      };
    }
    const segContent = JSON.stringify(segCard);

    try {
      if (i === 0 && replyTo) {
        await client.im.message.reply({
          path: { message_id: replyTo },
          data: { msg_type: "interactive", content: segContent },
        });
      } else {
        await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "interactive", content: segContent },
        });
      }
    } catch (err) {
      const e = err as Record<string, unknown>;
      const response = (e.response as Record<string, unknown>) || {};
      const respData = response.data || (e as Record<string, unknown>).data;
      const errorDetail = {
        message: (err as Error).message,
        code: e.code,
        status: e.status,
        responseData: respData,
        segmentIndex: i,
        segmentLength: segments[i].length,
        segmentPreview: segments[i].slice(0, 500),
        cardJson: segContent.slice(0, 500),
      };
      console.error("[lark] Card failed, falling back to text:", JSON.stringify(errorDetail));
      await sendText(chatId, segments[i], i === 0 ? replyTo : undefined);
    }

    if (i < segments.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// ==================== Reaction ====================

export async function addReaction(
  messageId: string,
  emoji = "OnIt"
): Promise<string | undefined> {
  try {
    const resp = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    return (resp?.data as Record<string, string> | undefined)?.reaction_id;
  } catch {
    return undefined;
  }
}

export async function removeReaction(
  messageId: string,
  reactionId: string
): Promise<void> {
  try {
    await client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {
    // silent
  }
}

// ==================== Image / File ====================

export async function uploadImage(imagePath: string): Promise<string> {
  const resp = await client.im.image.create({
    data: {
      image_type: "message",
      image: fs.readFileSync(imagePath),
    },
  });
  return (resp as unknown as Record<string, unknown>)?.image_key as string || "";
}

export async function sendImage(
  chatId: string,
  imageKey: string,
  replyTo?: string
): Promise<void> {
  const content = JSON.stringify({ image_key: imageKey });
  if (replyTo) {
    await client.im.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: "image", content },
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "image", content },
    });
  }
}

export async function uploadFile(filePath: string, fileName: string): Promise<string> {
  const resp = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: fileName,
      file: fs.readFileSync(filePath),
    },
  });
  return (resp as unknown as Record<string, unknown>)?.file_key as string || "";
}

export async function sendFile(
  chatId: string,
  fileKey: string,
  replyTo?: string
): Promise<void> {
  const content = JSON.stringify({ file_key: fileKey });
  if (replyTo) {
    await client.im.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: "file", content },
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "file", content },
    });
  }
}

export async function downloadResource(
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  savePath: string
): Promise<void> {
  const resp = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  await resp.writeFile(savePath);
}

// ==================== Chat list ====================

export async function fetchChatList(): Promise<
  Array<{ chatId: string; name: string }>
> {
  const chats: Array<{ chatId: string; name: string }> = [];
  const resp = await client.im.chat.list({
    params: { page_size: 100 },
  });
  const items = resp?.data?.items || [];
  for (const item of items) {
    if (item.chat_id && item.name) {
      chats.push({ chatId: item.chat_id, name: item.name });
    }
  }
  return chats;
}
