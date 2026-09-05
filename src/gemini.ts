// Tiny Gemini REST client using plain fetch on purpose — no SDK, so nothing
// can break on Workers. Endpoint cheat sheet is in PLAN.md section 13.

import type { Env } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** One text part inside a Gemini message. */
export interface GeminiPart {
  text?: string;
}

/** One conversation turn, as Gemini expects it. */
export interface GeminiContentMessage {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** A human-friendly error; we log details but never show raw errors to Troy. */
export class GeminiError extends Error {}

// --- Types of what Gemini sends back (we only use what we need) ---
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Sends the system prompt + history + the new user message to Gemini and
 * returns the plain text answer.
 */
export async function generateTextReply(opts: {
  env: Env;
  systemPrompt: string;
  history: GeminiContentMessage[];
  userText: string;
}): Promise<string> {
  const { env, systemPrompt, history, userText } = opts;
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";

  const url = `${API_BASE}/models/${model}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [...history, { role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.7 },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      // Gemini may take a while, but we must stay inside the handler budget
      // (~25s) — give up after 15s and let Telegram retry the whole update.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error("Gemini fetch failed:", err);
    throw new GeminiError("Could not reach Gemini");
  }

  const raw = await response.text();
  if (!response.ok) {
    console.error(
      `Gemini HTTP ${response.status}:`,
      raw.slice(0, 1000)
    );
    throw new GeminiError(`Gemini HTTP ${response.status}`);
  }

  let data: GeminiResponse;
  try {
    data = JSON.parse(raw) as GeminiResponse;
  } catch {
    console.error("Gemini returned unreadable JSON:", raw.slice(0, 500));
    throw new GeminiError("Gemini returned unreadable JSON");
  }

  // The request was blocked by safety filters — worth logging loudly.
  if (data.promptFeedback?.blockReason) {
    console.error("Gemini blocked the request:", data.promptFeedback.blockReason);
    throw new GeminiError("Gemini blocked the request");
  }

  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) {
    console.error("Gemini gave no candidate:", raw.slice(0, 1000));
    throw new GeminiError("Gemini gave no answer");
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    // e.g. MAX_TOKENS / SAFETY — return what we got, but say something first.
    console.error("Gemini finishReason:", candidate.finishReason);
  }

  const text = (candidate.content.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!text) {
    console.error("Gemini returned an empty answer:", raw.slice(0, 1000));
    throw new GeminiError("Gemini returned an empty answer");
  }
  return text;
}
