import { QUIPBENCH_MODELS } from "./models";
import { updatePairElo } from "./elo";
import { buildLeaderboard } from "./leaderboard";
import { openBenchDb, replaceRatings } from "./db";
import { DEFAULT_DB_PATH, DEFAULT_OUTPUT_DIR } from "./config";
import { exportLatestSnapshot } from "./export";
import type { RatingState } from "./types";

const db = openBenchDb(DEFAULT_DB_PATH);

try {
  const run = db.query(`
    SELECT id, initial_elo, elo_k, rounds_requested
    FROM runs
    WHERE status = 'running'
    ORDER BY datetime(started_at) DESC
    LIMIT 1
  `).get() as { id: string; initial_elo: number; elo_k: number; rounds_requested: number } | null;

  if (!run) {
    throw new Error("No running Quipbench run found to finalize");
  }

  const ratings = new Map<string, RatingState>();
  for (const model of QUIPBENCH_MODELS) {
    ratings.set(model.id, {
      model,
      elo: run.initial_elo,
      wins: 0,
      games: 0,
    });
  }

  const matches = db.query(`
    SELECT contestant_a_id, contestant_b_id, winner
    FROM matches
    WHERE run_id = $run_id
    ORDER BY round_num ASC, id ASC
  `).all({ $run_id: run.id }) as Array<{
    contestant_a_id: string;
    contestant_b_id: string;
    winner: "A" | "B" | "TIE" | "ERROR";
  }>;

  let completed = 0;
  let failures = 0;

  for (const match of matches) {
    const a = ratings.get(match.contestant_a_id);
    const b = ratings.get(match.contestant_b_id);
    if (!a || !b) continue;

    if (match.winner === "ERROR") {
      failures += 1;
      continue;
    }

    completed += 1;
    a.games += 1;
    b.games += 1;

    let scoreA = 0.5;
    if (match.winner === "A") {
      scoreA = 1;
      a.wins += 1;
    } else if (match.winner === "B") {
      scoreA = 0;
      b.wins += 1;
    }

    const next = updatePairElo(a.elo, b.elo, scoreA, run.elo_k);
    a.elo = next.nextA;
    b.elo = next.nextB;
  }

  const leaderboard = buildLeaderboard(Array.from(ratings.values()));
  replaceRatings(db, run.id, leaderboard);

  db.prepare(`
    UPDATE runs
    SET status = 'completed',
        ended_at = $ended_at,
        rounds_completed = $rounds_completed,
        failures = $failures
    WHERE id = $run_id
  `).run({
    $run_id: run.id,
    $ended_at: new Date().toISOString(),
    $rounds_completed: completed,
    $failures: failures,
  });

  const out = await exportLatestSnapshot({
    dbPath: DEFAULT_DB_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    runId: run.id,
  });

  console.log(`Finalized partial run: ${run.id}`);
  console.log(`Completed rounds: ${completed}`);
  console.log(`Failures: ${failures}`);
  console.log(`Snapshot JS: ${out.latestJsPath}`);
} finally {
  db.close();
}
