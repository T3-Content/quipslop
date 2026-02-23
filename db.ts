import { Database } from "bun:sqlite";
import type { RoundState } from "./game.ts";

const dbPath = process.env.DATABASE_PATH ?? "quipslop.sqlite";
export const db = new Database(dbPath, { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    data TEXT
  );
`);
db.exec("PRAGMA journal_mode = WAL;");

const insertRound = db.prepare("INSERT INTO rounds (num, data) VALUES ($num, $data)");
const countRounds = db.query("SELECT COUNT(*) as count FROM rounds");
const selectRoundsPage = db.prepare("SELECT data FROM rounds ORDER BY num DESC, id DESC LIMIT $limit OFFSET $offset");
const selectAllRounds = db.query("SELECT data FROM rounds ORDER BY num ASC, id ASC");

export function saveRound(round: RoundState) {
  insertRound.run({ $num: round.num, $data: JSON.stringify(round) });
}

export function getRounds(page: number = 1, limit: number = 10) {
  const offset = (page - 1) * limit;
  const countQuery = countRounds.get() as { count: number };
  const rows = selectRoundsPage.all({ $limit: limit, $offset: offset }) as { data: string }[];
  return {
    rounds: rows.map(r => JSON.parse(r.data) as RoundState),
    total: countQuery.count,
    page,
    limit,
    totalPages: Math.ceil(countQuery.count / limit)
  };
}

export function getAllRounds() {
  const rows = selectAllRounds.all() as { data: string }[];
  return rows.map(r => JSON.parse(r.data) as RoundState);
}

export function clearAllRounds() {
  db.exec("DELETE FROM rounds;");
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'rounds';");
}
