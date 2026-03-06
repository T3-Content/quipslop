import { Database } from "bun:sqlite";
import type { LeaderboardRow, MatchRecord, RunMeta } from "./types";

export type RunRow = {
  id: string;
  started_at: string;
  ended_at: string | null;
  rounds_requested: number;
  rounds_completed: number;
  failures: number;
  concurrency: number;
  elo_k: number;
  initial_elo: number;
  seed: number;
  status: string;
  output_dir: string;
};

export function openBenchDb(path: string): Database {
  const db = new Database(path, { create: true });
  initSchema(db);
  return db;
}

function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      rounds_requested INTEGER NOT NULL,
      rounds_completed INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      concurrency INTEGER NOT NULL,
      elo_k REAL NOT NULL,
      initial_elo REAL NOT NULL,
      seed INTEGER NOT NULL,
      status TEXT NOT NULL,
      output_dir TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      round_num INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      prompter_id TEXT NOT NULL,
      prompter_name TEXT NOT NULL,
      contestant_a_id TEXT NOT NULL,
      contestant_a_name TEXT NOT NULL,
      contestant_b_id TEXT NOT NULL,
      contestant_b_name TEXT NOT NULL,
      prompt TEXT,
      answer_a TEXT,
      answer_b TEXT,
      votes_a INTEGER NOT NULL DEFAULT 0,
      votes_b INTEGER NOT NULL DEFAULT 0,
      winner TEXT NOT NULL,
      error TEXT,
      payload_json TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      elo REAL NOT NULL,
      wins INTEGER NOT NULL,
      games INTEGER NOT NULL,
      win_rate REAL NOT NULL,
      rank INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_matches_run_id ON matches(run_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_run_id ON ratings(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
  `);
}

export function insertRunStart(
  db: Database,
  row: {
    id: string;
    startedAt: string;
    roundsRequested: number;
    concurrency: number;
    eloK: number;
    initialElo: number;
    seed: number;
    outputDir: string;
  },
) {
  const stmt = db.prepare(`
    INSERT INTO runs (
      id,
      started_at,
      rounds_requested,
      concurrency,
      elo_k,
      initial_elo,
      seed,
      status,
      output_dir
    ) VALUES (
      $id,
      $started_at,
      $rounds_requested,
      $concurrency,
      $elo_k,
      $initial_elo,
      $seed,
      'running',
      $output_dir
    )
  `);

  stmt.run({
    $id: row.id,
    $started_at: row.startedAt,
    $rounds_requested: row.roundsRequested,
    $concurrency: row.concurrency,
    $elo_k: row.eloK,
    $initial_elo: row.initialElo,
    $seed: row.seed,
    $output_dir: row.outputDir,
  });
}

export function updateRunProgress(
  db: Database,
  runId: string,
  progress: { roundsCompleted: number; failures: number },
) {
  const stmt = db.prepare(`
    UPDATE runs
    SET rounds_completed = $rounds_completed,
        failures = $failures
    WHERE id = $id
  `);
  stmt.run({
    $id: runId,
    $rounds_completed: progress.roundsCompleted,
    $failures: progress.failures,
  });
}

export function finalizeRun(
  db: Database,
  runId: string,
  status: "completed" | "failed",
  endedAt: string,
) {
  const stmt = db.prepare(`
    UPDATE runs
    SET status = $status,
        ended_at = $ended_at
    WHERE id = $id
  `);
  stmt.run({
    $id: runId,
    $status: status,
    $ended_at: endedAt,
  });
}

export function insertMatch(db: Database, match: MatchRecord) {
  const stmt = db.prepare(`
    INSERT INTO matches (
      run_id,
      round_num,
      prompter_id,
      prompter_name,
      contestant_a_id,
      contestant_a_name,
      contestant_b_id,
      contestant_b_name,
      prompt,
      answer_a,
      answer_b,
      votes_a,
      votes_b,
      winner,
      error,
      payload_json
    ) VALUES (
      $run_id,
      $round_num,
      $prompter_id,
      $prompter_name,
      $contestant_a_id,
      $contestant_a_name,
      $contestant_b_id,
      $contestant_b_name,
      $prompt,
      $answer_a,
      $answer_b,
      $votes_a,
      $votes_b,
      $winner,
      $error,
      $payload_json
    )
  `);

  stmt.run({
    $run_id: match.runId,
    $round_num: match.roundNum,
    $prompter_id: match.prompter.id,
    $prompter_name: match.prompter.name,
    $contestant_a_id: match.contestantA.id,
    $contestant_a_name: match.contestantA.name,
    $contestant_b_id: match.contestantB.id,
    $contestant_b_name: match.contestantB.name,
    $prompt: match.prompt ?? null,
    $answer_a: match.answerA ?? null,
    $answer_b: match.answerB ?? null,
    $votes_a: match.votesA,
    $votes_b: match.votesB,
    $winner: match.winner,
    $error: match.error ?? null,
    $payload_json: JSON.stringify(match),
  });
}

export function replaceRatings(
  db: Database,
  runId: string,
  leaderboard: LeaderboardRow[],
) {
  db.prepare("DELETE FROM ratings WHERE run_id = $run_id").run({ $run_id: runId });

  const stmt = db.prepare(`
    INSERT INTO ratings (
      run_id,
      model_id,
      model_name,
      elo,
      wins,
      games,
      win_rate,
      rank
    ) VALUES (
      $run_id,
      $model_id,
      $model_name,
      $elo,
      $wins,
      $games,
      $win_rate,
      $rank
    )
  `);

  const tx = db.transaction((rows: LeaderboardRow[]) => {
    for (const row of rows) {
      stmt.run({
        $run_id: runId,
        $model_id: row.modelId,
        $model_name: row.modelName,
        $elo: row.elo,
        $wins: row.wins,
        $games: row.games,
        $win_rate: row.winRate,
        $rank: row.rank,
      });
    }
  });

  tx(leaderboard);
}

export function getLatestCompletedRunId(db: Database): string | null {
  const row = db
    .query(
      `
      SELECT id
      FROM runs
      WHERE status = 'completed'
      ORDER BY datetime(ended_at) DESC, datetime(started_at) DESC
      LIMIT 1
    `,
    )
    .get() as { id: string } | null;

  return row?.id ?? null;
}

export function getRunRow(db: Database, runId: string): RunRow | null {
  return (
    (db
      .query(`
      SELECT
        id,
        started_at,
        ended_at,
        rounds_requested,
        rounds_completed,
        failures,
        concurrency,
        elo_k,
        initial_elo,
        seed,
        status,
        output_dir
      FROM runs
      WHERE id = $run_id
      LIMIT 1
    `)
      .get({ $run_id: runId }) as RunRow | null) ?? null
  );
}

export function getRatingsForRun(
  db: Database,
  runId: string,
): LeaderboardRow[] {
  const rows = db
    .query(`
      SELECT
        rank,
        model_id,
        model_name,
        elo,
        wins,
        games,
        win_rate
      FROM ratings
      WHERE run_id = $run_id
      ORDER BY rank ASC
    `)
    .all({ $run_id: runId }) as Array<{
    rank: number;
    model_id: string;
    model_name: string;
    elo: number;
    wins: number;
    games: number;
    win_rate: number;
  }>;

  return rows.map((row) => ({
    rank: row.rank,
    modelId: row.model_id,
    modelName: row.model_name,
    elo: row.elo,
    wins: row.wins,
    games: row.games,
    winRate: row.win_rate,
  }));
}

export function runRowToMeta(row: RunRow): RunMeta {
  if (!row.ended_at) {
    throw new Error(`Run ${row.id} is not finalized`);
  }

  return {
    runId: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    roundsRequested: row.rounds_requested,
    roundsCompleted: row.rounds_completed,
    failures: row.failures,
    concurrency: row.concurrency,
    eloK: row.elo_k,
    initialElo: row.initial_elo,
    seed: row.seed,
  };
}
