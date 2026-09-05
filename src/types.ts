// Shared types for the whole project.

// Everything available to the worker comes from `env`:
// plain vars are in wrangler.jsonc, secrets are typed into the Cloudflare
// dashboard (Settings -> Variables and Secrets) and into local .dev.vars.
export interface Env {
  // Telegram bot token from @BotFather (Secret).
  BOT_TOKEN: string;
  // Gemini API key from aistudio.google.com (Secret).
  GEMINI_API_KEY: string;
  // Any random string 32+ chars, protects /webhook and /init (Secret).
  WEBHOOK_SECRET: string;
  // Optional numeric Telegram user id of the owner (Secret).
  // When unset, the bot tells everyone their id so Troy can lock it.
  OWNER_ID?: string;
  // Chat model, overridable via wrangler.jsonc vars.
  GEMINI_MODEL?: string;
  // IANA timezone name, e.g. "Asia/Manila".
  TIMEZONE?: string;
  // D1 database binding, configured in wrangler.jsonc.
  DB: D1Database;
  // Optional override of the Telegram API base URL (default: real Telegram).
  // Only used for local development/testing against a mock server. Set it in
  // .dev.vars locally; never needed in Cloudflare.
  TELEGRAM_API_ROOT?: string;
}

// One stored chat message row in D1.
export interface MessageRow {
  id: number;
  chat_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: number;
}
