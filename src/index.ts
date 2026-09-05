// Worker entry point. Routes:
//   POST /webhook  -> Telegram webhook (secret-token checked, grammY)
//   GET  /init     -> sets the webhook + bot commands (needs ?secret=)
//   GET  /health   -> says ok
//
// Webhook only — no long polling, no servers. See PLAN.md section 6.

import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import type { Env } from "./types";
import { createBot } from "./bot";
import { apiCall } from "./telegram";

// grammY may take up to ~25s (Gemini + tools). If it runs longer than that we
// throw, return 500, and Telegram retries the update later — the retry is
// safe because updates are only marked "processed" after success (src/bot.ts).
const HANDLER_TIMEOUT_MS = 25_000;

// One bot + callback per isolate, created lazily (env is fixed per deploy).
// The setup does ONE getMe with a short timeout and passes the result to
// grammY as botInfo — this skips grammY's own untimed init/getMe on the first
// request (which could otherwise hang if Telegram is unreachable).
type HandleUpdate = (request: Request) => Promise<Response>;

let handleUpdatePromise: Promise<HandleUpdate> | undefined;

function getHandleUpdate(env: Env): Promise<HandleUpdate> {
  handleUpdatePromise ??= buildHandleUpdate(env);
  return handleUpdatePromise;
}

async function buildHandleUpdate(env: Env): Promise<HandleUpdate> {
  const me = await apiCall(env.BOT_TOKEN, "getMe", {}, env.TELEGRAM_API_ROOT);
  const botInfo = me.ok ? (me.result as UserFromGetMe) : undefined;
  const bot = createBot(env, botInfo);
  return webhookCallback(bot, "cloudflare-mod", {
    secretToken: env.WEBHOOK_SECRET, // checks X-Telegram-Bot-Api-Secret-Token
    timeoutMilliseconds: HANDLER_TIMEOUT_MS,
    onTimeout: "throw",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check: https://<worker>/health -> "ok"
    if (url.pathname === "/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // One-time setup: https://<worker>/init?secret=<WEBHOOK_SECRET>
    if (url.pathname === "/init" && request.method === "GET") {
      return handleInit(url, env);
    }

    // Telegram webhook (already verified by Telegram's secret token below).
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Defend the endpoint even outside grammY (defense in depth).
      if (
        request.headers.get("x-telegram-bot-api-secret-token") !==
        env.WEBHOOK_SECRET
      ) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        return await (await getHandleUpdate(env))(request);
      } catch (err) {        console.error("Webhook handling failed:", err);
        // 500 -> Telegram retries later (dedupe protects us from double work).
        return new Response("internal error", { status: 500 });
      }
    }

    // Anything else: a tiny pointer page, handy when opening the URL.
    return new Response(
      [
        "agent-troy worker is running.",
        "Routes:",
        "  GET  /health -> ok",
        `  GET  /init?secret=... -> set the Telegram webhook`,
        "  POST /webhook -> Telegram updates",
      ].join("\n"),
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  },
};

/** /init — tells Telegram where to send updates and registers the commands. */
async function handleInit(url: URL, env: Env): Promise<Response> {
  const secret = url.searchParams.get("secret") ?? "";
  if (secret === "" || secret !== env.WEBHOOK_SECRET) {
    return new Response("403 forbidden — wrong or missing secret.", {
      status: 403,
    });
  }

  const webhookUrl = `${url.origin}/webhook`;
  const lines: string[] = [];

  // 1. Point Telegram at this worker.
  const set = await apiCall(
    env.BOT_TOKEN,
    "setWebhook",
    {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      drop_pending_updates: true,
    },
    env.TELEGRAM_API_ROOT
  );
  lines.push(
    set.ok
      ? `Webhook set ✅ (${webhookUrl})`
      : `setWebhook FAILED: ${set.description ?? "unknown error"}`
  );

  // 2. Register the slash commands shown in the Telegram chat.
  const commands = [
    { command: "start", description: "Hello + what I can do" },
    { command: "help", description: "What I can do" },
    { command: "reset", description: "Clear this chat's memory" },
    { command: "id", description: "Show your Telegram user id" },
  ];
  const cmds = await apiCall(
    env.BOT_TOKEN,
    "setMyCommands",
    { commands },
    env.TELEGRAM_API_ROOT
  );
  lines.push(
    cmds.ok
      ? "Commands registered ✅"
      : `setMyCommands FAILED: ${cmds.description ?? "unknown error"}`
  );

  lines.push(
    "",
    "Next: open Telegram, message your bot and send /start.",
    "If OWNER_ID is not set yet, the bot tells you your user id."
  );

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
