// D1 helpers. The schema is created lazily on first use (CREATE TABLE IF NOT
// EXISTS), so there is no migration step for Troy — the first message the bot
// receives creates the tables automatically.

import type { MessageRow } from "./types";

/** Creates both tables if they do not exist yet. Safe to call repeatedly. */
export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,            -- "user" or "assistant"
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL    -- unix milliseconds (UTC)
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY, -- Telegram update id
        created_at INTEGER NOT NULL    -- unix milliseconds (UTC)
      )`
    ),
  ]);
}

/** Saves one chat message (user or assistant) into memory. */
export async function insertMessage(
  db: D1Database,
  chatId: number,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)"
    )
    .bind(chatId, role, content, Date.now())
    .run();
}

/**
 * The last `limit` messages of one chat, oldest first. We pass them to Gemini
 * as conversation history so the bot remembers the chat.
 */
export async function getRecentMessages(
  db: D1Database,
  chatId: number,
  limit = 30
): Promise<MessageRow[]> {
  const result = await db
    .prepare(
      "SELECT id, chat_id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?"
    )
    .bind(chatId, limit)
    .all<MessageRow>();
  // ORDER BY id DESC gave us the newest first — flip it back for Gemini.
  return (result.results ?? []).reverse();
}

/** /reset — forgets everything said in this chat (notes/todos are NOT here yet in Step 1). */
export async function deleteChatHistory(
  db: D1Database,
  chatId: number
): Promise<void> {
  await db
    .prepare("DELETE FROM messages WHERE chat_id = ?")
    .bind(chatId)
    .run();
}

/** Telegram can retry the same update — we never want to answer twice. */
export async function isUpdateProcessed(
  db: D1Database,
  updateId: number
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS seen FROM processed_updates WHERE update_id = ?")
    .bind(updateId)
    .first<{ seen: number }>();
  return row !== null;
}

/** Records an update id after it was handled successfully. */
export async function markUpdateProcessed(
  db: D1Database,
  updateId: number
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)"
    )
    .bind(updateId, Date.now())
    .run();
}
