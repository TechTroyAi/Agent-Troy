// Small helpers that talk to the Telegram Bot API directly with plain fetch.
// (No SDK needed for these — grammY is only used for the webhook plumbing.)

const DEFAULT_API_ROOT = "https://api.telegram.org";

/** An AbortSignal that fires after `ms` milliseconds — nothing may hang forever. */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** One response from the Telegram Bot API (simplified). */
export interface TelegramResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/**
 * Calls any Bot API method, e.g. apiCall(token, "sendMessage", {...}).
 * `apiRoot` lets local tests point at a mock server (see TELEGRAM_API_ROOT).
 */
export async function apiCall(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  apiRoot = DEFAULT_API_ROOT
): Promise<TelegramResult> {
  try {
    const response = await fetch(`${apiRoot}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: timeoutSignal(5_000), // Telegram is fast; don't wait forever
    });
    const data = (await response.json()) as TelegramResult;
    return { ok: data.ok, description: data.description, result: data.result };
  } catch (err) {
    // Log the real error; the caller decides what to tell the user.
    console.error(`Telegram apiCall ${method} failed:`, err);
    return { ok: false, description: "network error" };
  }
}

/** Shows the "typing..." bubble in the chat while we work. */
export async function sendChatAction(
  token: string,
  chatId: number,
  action = "typing",
  apiRoot = DEFAULT_API_ROOT
): Promise<void> {
  await apiCall(token, "sendChatAction", { chat_id: chatId, action }, apiRoot);
}

/**
 * Telegram messages are limited to 4096 characters — split longer replies
 * into several chunks. Breaks on newlines when possible.
 */
export function splitLongText(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    // Prefer cutting after a newline inside the window, so words survive.
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < maxLength / 2) cut = maxLength; // no good newline nearby
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Sends a message, splitting it if needed. Plain text, no parse mode. */
export async function sendTextChunks(
  token: string,
  chatId: number,
  text: string,
  apiRoot = DEFAULT_API_ROOT
): Promise<boolean> {
  const chunks = splitLongText(text);
  let allOk = true;
  for (const chunk of chunks) {
    const result = await apiCall(
      token,
      "sendMessage",
      { chat_id: chatId, text: chunk },
      apiRoot
    );
    if (!result.ok) allOk = false;
  }
  return allOk;
}
