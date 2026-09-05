// The grammY bot: commands, owner check, dedupe of Telegram retries, and the
// chat message handler that sends everything through the agent.

import { Bot, Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import type { Env } from "./types";
import {
  deleteChatHistory,
  ensureSchema,
  isUpdateProcessed,
  markUpdateProcessed,
} from "./db";
import { runAgent } from "./agent";
import { sendChatAction, sendTextChunks } from "./telegram";

// Text constants (plain text on purpose — no markdown characters).
const START_TEXT = [
  "Hey Troy! 👋 I'm your personal assistant, running 24/7 on Cloudflare.",
  "",
  "Right now I can:",
  "- chat with you and remember what we talked about in this chat",
  "",
  "Commands:",
  "/start — hello",
  "/help — what I can do",
  "/reset — forget this chat's memory (notes/to-dos aren't here yet)",
  "/id — your Telegram user id",
].join("\n");

const HELP_TEXT = [
  "What I can do right now:",
  "- Chat: just talk to me, I remember this chat's history",
  "- /reset — clear my memory of this chat",
  "- /id — show your Telegram user id",
  "- /help — this message",
  "",
  "Web search, notes, to-dos, reminders and more come in later steps.",
].join("\n");

/**
 * Creates the grammY bot wired to this environment.
 * @param botInfo optional result of getMe — pass it so grammY skips its own
 *   untimed getMe round-trip on the first update.
 */
export function createBot(env: Env, botInfo?: UserFromGetMe): Bot<Context> {
  // apiRoot is only set for local tests against a mock Telegram server.
  const config: ConstructorParameters<typeof Bot<Context>>[1] = {
    ...(env.TELEGRAM_API_ROOT ? { client: { apiRoot: env.TELEGRAM_API_ROOT } } : {}),
    ...(botInfo ? { botInfo } : {}),
  };
  const bot = new Bot<Context>(env.BOT_TOKEN, config);

  // ---- 1. Never reply twice to the same update (Telegram retries) ----
  bot.use(async (ctx, next) => {
    await ensureSchema(env.DB);
    const updateId = ctx.update.update_id;
    if (await isUpdateProcessed(env.DB, updateId)) return; // already handled
    await next(); // run the real handlers
    // Mark only AFTER success: if something failed, Telegram retries and we
    // run it again instead of silently swallowing the update.
    await markUpdateProcessed(env.DB, updateId);
  });

  // ---- 2. Owner check: only Troy may use the bot ----
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return; // not a private chat message — ignore
    const owner = env.OWNER_ID?.trim() ?? "";
    if (owner === "") {
      // Not locked yet: this is how Troy learns his user id.
      if (ctx.message) {
        await safeReply(
          ctx,
          `Your Telegram id is ${fromId}. Add it as OWNER_ID in Cloudflare to lock the bot.`
        );
      }
      return;
    }
    if (String(fromId) !== owner) {
      if (ctx.message) await safeReply(ctx, "Private bot.");
      return;
    }
    await next(); // it's Troy — continue
  });

  // ---- 3. Commands ----
  bot.command("start", async (ctx) => {
    await safeReply(ctx, START_TEXT);
  });

  bot.command("help", async (ctx) => {
    await safeReply(ctx, HELP_TEXT);
  });

  bot.command("id", async (ctx) => {
    const id = ctx.from?.id;
    await safeReply(
      ctx,
      id === undefined ? "I can't see your id." : `Your Telegram user id is ${id}.`
    );
  });

  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id;
    await deleteChatHistory(env.DB, chatId);
    await safeReply(ctx, "Done — I've forgotten everything we talked about in this chat. My memory is clean.");
  });

  // ---- 4. Chat messages go through the agent (Gemini + memory) ----
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    try {
      // Show "typing..." while Gemini thinks (fire-and-forget is fine).
      void sendChatAction(
        env.BOT_TOKEN,
        chatId,
        "typing",
        env.TELEGRAM_API_ROOT
      ).catch(() => {});
      const reply = await runAgent({ env, chatId, userText });
      await sendTextChunks(env.BOT_TOKEN, chatId, reply, env.TELEGRAM_API_ROOT);
    } catch (err) {
      // Friendly message for Troy; the real error goes to the logs.
      console.error("Message handling failed:", err);
      await sendTextChunks(
        env.BOT_TOKEN,
        chatId,
        "Gemini is busy, try again in a minute.",
        env.TELEGRAM_API_ROOT
      ).catch(() => {});
    }
  });

  return bot;
}

/** Replies to a message but never lets a reply failure crash the flow. */
async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err) {
    console.error("Reply failed:", err);
  }
}
