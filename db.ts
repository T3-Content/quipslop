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

export function saveRound(round: RoundState) {
  const insert = db.prepare("INSERT INTO rounds (num, data) VALUES ($num, $data)");
  insert.run({ $num: round.num, $data: JSON.stringify(round) });
}

export function getRounds(page: number = 1, limit: number = 10) {
  const offset = (page - 1) * limit;
  const countQuery = db.query("SELECT COUNT(*) as count FROM rounds").get() as { count: number };
  const rows = db.query("SELECT data FROM rounds ORDER BY num DESC, id DESC LIMIT $limit OFFSET $offset")
    .all({ $limit: limit, $offset: offset }) as { data: string }[];
  return {
    rounds: rows.map(r => JSON.parse(r.data) as RoundState),
    total: countQuery.count,
    page,
    limit,
    totalPages: Math.ceil(countQuery.count / limit)
  };
}

export function getAllRounds() {
  const rows = db.query("SELECT data FROM rounds ORDER BY num ASC, id ASC").all() as { data: string }[];
  return rows.map(r => JSON.parse(r.data) as RoundState);
}

export function clearAllRounds() {
  db.exec("DELETE FROM rounds;");
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'rounds';");
}

// ── Betting tables ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nickname TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 1000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    contestant TEXT NOT NULL,
    amount INTEGER NOT NULL,
    won INTEGER,
    payout INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, round_num)
  );
`);

// ── Betting functions ───────────────────────────────────────────────────────

export function createUser(id: string, nickname: string) {
  const stmt = db.prepare("INSERT INTO users (id, nickname) VALUES ($id, $nickname)");
  stmt.run({ $id: id, $nickname: nickname });
  return { id, nickname, balance: 1000 };
}

export function getUser(id: string) {
  return db.query("SELECT id, nickname, balance FROM users WHERE id = $id").get({ $id: id }) as { id: string; nickname: string; balance: number } | null;
}

export function placeBet(userId: string, roundNum: number, contestant: string, amount: number) {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");
  if (amount <= 0) throw new Error("Amount must be positive");
  if (amount > user.balance) throw new Error("Insufficient balance");

  const existing = db.query("SELECT id FROM bets WHERE user_id = $userId AND round_num = $roundNum").get({ $userId: userId, $roundNum: roundNum });
  if (existing) throw new Error("Already bet this round");

  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO bets (user_id, round_num, contestant, amount) VALUES ($userId, $roundNum, $contestant, $amount)")
      .run({ $userId: userId, $roundNum: roundNum, $contestant: contestant, $amount: amount });
    db.prepare("UPDATE users SET balance = balance - $amount WHERE id = $userId")
      .run({ $amount: amount, $userId: userId });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return {
    bet: { userId, roundNum, contestant, amount },
    balance: user.balance - amount,
  };
}

export function resolveBets(roundNum: number, winnerName: string | null) {
  const bets = db.query("SELECT id, user_id, contestant, amount FROM bets WHERE round_num = $roundNum AND won IS NULL")
    .all({ $roundNum: roundNum }) as { id: number; user_id: string; contestant: string; amount: number }[];

  if (bets.length === 0) return;

  db.exec("BEGIN");
  try {
    for (const bet of bets) {
      if (winnerName === null) {
        // Tie — refund
        db.prepare("UPDATE bets SET won = 0, payout = $amount WHERE id = $id")
          .run({ $amount: bet.amount, $id: bet.id });
        db.prepare("UPDATE users SET balance = balance + $amount WHERE id = $userId")
          .run({ $amount: bet.amount, $userId: bet.user_id });
      } else if (bet.contestant === winnerName) {
        const payout = bet.amount * 2;
        db.prepare("UPDATE bets SET won = 1, payout = $payout WHERE id = $id")
          .run({ $payout: payout, $id: bet.id });
        db.prepare("UPDATE users SET balance = balance + $payout WHERE id = $userId")
          .run({ $payout: payout, $userId: bet.user_id });
      } else {
        db.prepare("UPDATE bets SET won = 0, payout = 0 WHERE id = $id")
          .run({ $id: bet.id });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getLeaderboard(limit = 10) {
  return db.query("SELECT id, nickname, balance FROM users ORDER BY balance DESC LIMIT $limit")
    .all({ $limit: limit }) as { id: string; nickname: string; balance: number }[];
}

export function getBetsForRound(roundNum: number) {
  const rows = db.query(
    "SELECT contestant, COUNT(*) as count, SUM(amount) as total FROM bets WHERE round_num = $roundNum GROUP BY contestant"
  ).all({ $roundNum: roundNum }) as { contestant: string; count: number; total: number }[];

  const result: Record<string, { count: number; total: number }> = {};
  for (const row of rows) {
    result[row.contestant] = { count: row.count, total: row.total };
  }
  return result;
}

export function getUserBetForRound(userId: string, roundNum: number) {
  return db.query("SELECT contestant, amount, won, payout FROM bets WHERE user_id = $userId AND round_num = $roundNum")
    .get({ $userId: userId, $roundNum: roundNum }) as { contestant: string; amount: number; won: number | null; payout: number } | null;
}

export function clearAllBets() {
  db.exec("DELETE FROM bets;");
  db.exec("DELETE FROM users;");
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'bets';");
}
