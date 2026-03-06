import { join } from "node:path";

export const BENCH_DIR = import.meta.dir;

export const DEFAULT_ROUNDS = 100;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_ELO_K = 24;
export const DEFAULT_INITIAL_ELO = 1500;

export const DEFAULT_DB_PATH = join(BENCH_DIR, "quipbench.sqlite");
export const DEFAULT_OUTPUT_DIR = join(BENCH_DIR, "out");
export const DEFAULT_LATEST_JSON_PATH = join(DEFAULT_OUTPUT_DIR, "latest.json");
export const DEFAULT_LATEST_JS_PATH = join(DEFAULT_OUTPUT_DIR, "latest.js");

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePositiveNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
