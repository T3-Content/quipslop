import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runQuipbench } from "./run";
import type { BenchModel, QuipbenchAi } from "./types";

const TEST_MODELS: BenchModel[] = [
  { id: "model/a", name: "Model A" },
  { id: "model/b", name: "Model B" },
  { id: "model/c", name: "Model C" },
  { id: "model/d", name: "Model D" },
];

const STUB_AI: QuipbenchAi = {
  async generatePrompt(model) {
    return `Prompt by ${model.name}`;
  },
  async generateAnswer(model, prompt) {
    return `${model.name} answer for ${prompt}`;
  },
  async vote(_voter, _prompt, answerA, answerB) {
    return answerA.length >= answerB.length ? "A" : "B";
  },
};

test("run writes DB rows and latest snapshot", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "quipbench-it-"));
  const dbPath = join(tempRoot, "bench.sqlite");
  const outDir = join(tempRoot, "out");

  const result = await runQuipbench({
    rounds: 8,
    concurrency: 2,
    seed: 123,
    models: TEST_MODELS,
    ai: STUB_AI,
    dbPath,
    outputDir: outDir,
  });

  expect(result.runMeta.roundsRequested).toBe(8);
  expect(result.runMeta.roundsCompleted + result.runMeta.failures).toBe(8);
  expect(result.leaderboard.length).toBe(TEST_MODELS.length);

  const db = new Database(dbPath);
  const runsCount = (db.query("SELECT COUNT(*) as c FROM runs").get() as { c: number }).c;
  const matchesCount = (
    db.query("SELECT COUNT(*) as c FROM matches WHERE run_id = $run_id").get({
      $run_id: result.runMeta.runId,
    }) as { c: number }
  ).c;
  const ratingsCount = (
    db.query("SELECT COUNT(*) as c FROM ratings WHERE run_id = $run_id").get({
      $run_id: result.runMeta.runId,
    }) as { c: number }
  ).c;
  db.close();

  expect(runsCount).toBe(1);
  expect(matchesCount).toBe(8);
  expect(ratingsCount).toBe(TEST_MODELS.length);

  const latest = JSON.parse(readFileSync(result.snapshotPathJson, "utf8")) as {
    runMeta: { runId: string };
    leaderboard: unknown[];
    chart: unknown[];
  };

  expect(latest.runMeta.runId).toBe(result.runMeta.runId);
  expect(latest.leaderboard.length).toBe(TEST_MODELS.length);
  expect(latest.chart.length).toBe(TEST_MODELS.length);
});

test("round failures are persisted and run still finalizes", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "quipbench-it-fail-"));
  const dbPath = join(tempRoot, "bench.sqlite");
  const outDir = join(tempRoot, "out");

  const failingAi: QuipbenchAi = {
    async generatePrompt() {
      throw new Error("forced prompt failure");
    },
    async generateAnswer() {
      return "unused";
    },
    async vote() {
      return "A";
    },
  };

  const result = await runQuipbench({
    rounds: 3,
    concurrency: 2,
    seed: 7,
    models: TEST_MODELS,
    ai: failingAi,
    dbPath,
    outputDir: outDir,
  });

  expect(result.runMeta.roundsCompleted).toBe(0);
  expect(result.runMeta.failures).toBe(3);

  const db = new Database(dbPath);
  const errorMatches = (
    db
      .query("SELECT COUNT(*) as c FROM matches WHERE run_id = $run_id AND winner = 'ERROR'")
      .get({ $run_id: result.runMeta.runId }) as { c: number }
  ).c;
  db.close();

  expect(errorMatches).toBe(3);

  const latest = JSON.parse(readFileSync(result.snapshotPathJson, "utf8")) as {
    runMeta: { failures: number };
  };
  expect(latest.runMeta.failures).toBe(3);
});
