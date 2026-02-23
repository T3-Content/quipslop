import { db } from "./db.ts";
import type { ChatMessage } from "./chat.ts";

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    badges TEXT,
    is_subscriber INTEGER DEFAULT 0,
    is_mod INTEGER DEFAULT 0,
    round_num INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_chat_round ON chat_messages(round_num);
  CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
`);

// ── Persistence ─────────────────────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO chat_messages
    (id, username, display_name, content, timestamp, badges, is_subscriber, is_mod, round_num)
  VALUES ($id, $username, $displayName, $content, $timestamp, $badges, $isSubscriber, $isMod, $roundNum)
`);

const insertBatch = db.transaction((messages: ChatMessage[]) => {
  for (const msg of messages) {
    insertStmt.run({
      $id: msg.id,
      $username: msg.username,
      $displayName: msg.displayName,
      $content: msg.content,
      $timestamp: msg.timestamp,
      $badges: JSON.stringify(msg.badges),
      $isSubscriber: msg.isSubscriber ? 1 : 0,
      $isMod: msg.isMod ? 1 : 0,
      $roundNum: msg.roundNum,
    });
  }
});

const pendingMessages: ChatMessage[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

const FLUSH_INTERVAL_MS = 5_000;

function flush() {
  if (pendingMessages.length === 0) return;
  const batch = pendingMessages.splice(0);
  try {
    insertBatch(batch);
  } catch (err) {
    pendingMessages.unshift(...batch);
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[chat-store] flush failed, ${batch.length} messages re-queued: ${detail}`);
  }
}

export function queueMessage(message: ChatMessage) {
  pendingMessages.push(message);
  if (pendingMessages.length >= 50) {
    flush();
  }
}

export function startPersistence() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

export function stopPersistence() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flush();
}

// ── Queries ─────────────────────────────────────────────────────────────────

type ChatRow = {
  id: string;
  username: string;
  display_name: string;
  content: string;
  timestamp: number;
  badges: string;
  is_subscriber: number;
  is_mod: number;
  round_num: number | null;
};

function rowToMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    content: row.content,
    timestamp: row.timestamp,
    badges: JSON.parse(row.badges || "{}"),
    isSubscriber: row.is_subscriber === 1,
    isMod: row.is_mod === 1,
    roundNum: row.round_num,
  };
}

export function getRecentChat(limit = 50): ChatMessage[] {
  const rows = db
    .query(
      "SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT $limit",
    )
    .all({ $limit: limit }) as ChatRow[];
  return rows.reverse().map(rowToMessage);
}

export function getChatForRound(roundNum: number): ChatMessage[] {
  const rows = db
    .query(
      "SELECT * FROM chat_messages WHERE round_num = $roundNum ORDER BY timestamp ASC",
    )
    .all({ $roundNum: roundNum }) as ChatRow[];
  return rows.map(rowToMessage);
}

export function getChatCount(): number {
  const result = db
    .query("SELECT COUNT(*) as count FROM chat_messages")
    .get() as { count: number };
  return result.count;
}
