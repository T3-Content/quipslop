import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DB_PATH, DEFAULT_OUTPUT_DIR } from "./config";
import {
  getLatestCompletedRunId,
  getRatingsForRun,
  getRunRow,
  openBenchDb,
  runRowToMeta,
} from "./db";
import type { QuipbenchSnapshot } from "./types";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const stripped = raw.slice(2);
    const [key, ...rest] = stripped.split("=");
    if (!key) continue;
    args[key] = rest.length === 0 ? "true" : rest.join("=");
  }
  return args;
}

export async function exportLatestSnapshot(options?: {
  dbPath?: string;
  outputDir?: string;
  runId?: string;
}): Promise<{
  snapshot: QuipbenchSnapshot;
  latestJsonPath: string;
  latestJsPath: string;
}> {
  const dbPath = options?.dbPath ?? DEFAULT_DB_PATH;
  const outputDir = options?.outputDir ?? DEFAULT_OUTPUT_DIR;

  mkdirSync(outputDir, { recursive: true });

  const db = openBenchDb(dbPath);
  try {
    const runId = options?.runId ?? getLatestCompletedRunId(db);
    if (!runId) {
      throw new Error("No completed Quipbench runs found");
    }

    const runRow = getRunRow(db, runId);
    if (!runRow) {
      throw new Error(`Run not found: ${runId}`);
    }

    const leaderboard = getRatingsForRun(db, runId);
    if (leaderboard.length === 0) {
      throw new Error(`Run ${runId} has no ratings`);
    }

    const snapshot: QuipbenchSnapshot = {
      runMeta: runRowToMeta(runRow),
      leaderboard,
      chart: leaderboard.map((row) => ({
        modelName: row.modelName,
        elo: row.elo,
      })),
    };

    const latestJsonPath = join(outputDir, "latest.json");
    const latestJsPath = join(outputDir, "latest.js");

    writeFileSync(latestJsonPath, JSON.stringify(snapshot, null, 2));
    writeFileSync(
      latestJsPath,
      `window.__QUIPBENCH_LATEST__ = ${JSON.stringify(snapshot, null, 2)};\n`,
    );

    return { snapshot, latestJsonPath, latestJsPath };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db ? join(process.cwd(), args.db) : DEFAULT_DB_PATH;
  const outputDir = args.out ? join(process.cwd(), args.out) : DEFAULT_OUTPUT_DIR;
  const runId = args.runId;

  const result = await exportLatestSnapshot({ dbPath, outputDir, runId });
  console.log(`Exported snapshot: ${result.latestJsonPath}`);
  console.log(`Exported snapshot script: ${result.latestJsPath}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
