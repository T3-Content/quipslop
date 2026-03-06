import { db } from "./db.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS bench_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    config TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    total_rounds INTEGER NOT NULL,
    completed_rounds INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bench_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    pairing_index INTEGER NOT NULL,
    round_num INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES bench_runs(id)
  );
`);

export type BenchRunRow = {
  id: string;
  status: string;
  config: string;
  started_at: number;
  finished_at: number | null;
  total_rounds: number;
  completed_rounds: number;
  error: string | null;
};

export type BenchRoundRow = {
  id: number;
  run_id: string;
  pairing_index: number;
  round_num: number;
  data: string;
};

export function saveBenchRun(run: {
  id: string;
  status: string;
  config: object;
  startedAt: number;
  totalRounds: number;
}) {
  db.prepare(
    `INSERT INTO bench_runs (id, status, config, started_at, total_rounds, completed_rounds)
     VALUES ($id, $status, $config, $started_at, $total_rounds, 0)`,
  ).run({
    $id: run.id,
    $status: run.status,
    $config: JSON.stringify(run.config),
    $started_at: run.startedAt,
    $total_rounds: run.totalRounds,
  });
}

export function updateBenchRunStatus(
  id: string,
  update: {
    status?: string;
    completedRounds?: number;
    finishedAt?: number;
    error?: string;
  },
) {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };

  if (update.status !== undefined) {
    sets.push("status = $status");
    params.$status = update.status;
  }
  if (update.completedRounds !== undefined) {
    sets.push("completed_rounds = $completed_rounds");
    params.$completed_rounds = update.completedRounds;
  }
  if (update.finishedAt !== undefined) {
    sets.push("finished_at = $finished_at");
    params.$finished_at = update.finishedAt;
  }
  if (update.error !== undefined) {
    sets.push("error = $error");
    params.$error = update.error;
  }

  if (sets.length === 0) return;
  db.prepare(`UPDATE bench_runs SET ${sets.join(", ")} WHERE id = $id`).run(
    params,
  );
}

export function saveBenchRound(round: {
  runId: string;
  pairingIndex: number;
  roundNum: number;
  data: object;
}) {
  db.prepare(
    `INSERT INTO bench_rounds (run_id, pairing_index, round_num, data)
     VALUES ($run_id, $pairing_index, $round_num, $data)`,
  ).run({
    $run_id: round.runId,
    $pairing_index: round.pairingIndex,
    $round_num: round.roundNum,
    $data: JSON.stringify(round.data),
  });
}

export function getBenchRuns(): BenchRunRow[] {
  return db
    .query("SELECT * FROM bench_runs ORDER BY started_at DESC")
    .all() as BenchRunRow[];
}

export function getBenchRun(id: string): BenchRunRow | null {
  return (
    (db
      .query("SELECT * FROM bench_runs WHERE id = $id")
      .get({ $id: id }) as BenchRunRow | null) ?? null
  );
}

export function getBenchRounds(runId: string): BenchRoundRow[] {
  return db
    .query(
      "SELECT * FROM bench_rounds WHERE run_id = $run_id ORDER BY pairing_index ASC, round_num ASC",
    )
    .all({ $run_id: runId }) as BenchRoundRow[];
}

export function markStaleBenchRunsAsError() {
  db.prepare(
    `UPDATE bench_runs SET status = 'error', error = 'Server restarted', finished_at = $now
     WHERE status = 'running'`,
  ).run({ $now: Date.now() });
}
