// The agent: gather context (time + chat memory) -> call Gemini -> save the
// conversation. STEP 1 has no tools yet — later steps grow this file with the
// tool-calling loop.

import type { Env } from "./types";
import { buildSystemPrompt, formatCurrentTime } from "./prompt";
import {
  generateTextReply,
  type GeminiContentMessage,
} from "./gemini";
import { getRecentMessages, insertMessage } from "./db";

/** How many past messages of this chat we send to Gemini as memory. */
const MEMORY_MESSAGES = 30;

/**
 * Runs one chat turn: reads the chat's memory, asks Gemini, stores the
 * exchange, and returns the reply text.
 */
export async function runAgent(opts: {
  env: Env;
  chatId: number;
  userText: string;
}): Promise<string> {
  const { env, chatId, userText } = opts;

  const timezone = env.TIMEZONE || "Asia/Manila";
  const nowText = formatCurrentTime(new Date(), timezone);
  const systemPrompt = buildSystemPrompt(nowText);

  // Chat memory from D1, oldest first, ready for Gemini's format.
  const rows = await getRecentMessages(env.DB, chatId, MEMORY_MESSAGES);
  const history: GeminiContentMessage[] = rows.map((row) => ({
    role: row.role === "assistant" ? "model" : "user",
    parts: [{ text: row.content }],
  }));

  const reply = await generateTextReply({
    env,
    systemPrompt,
    history,
    userText,
  });

  // Remember the exchange (this is what /reset clears).
  await insertMessage(env.DB, chatId, "user", userText);
  await insertMessage(env.DB, chatId, "assistant", reply);

  return reply;
}
