import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DB_PATH,
  DEFAULT_ELO_K,
  DEFAULT_INITIAL_ELO,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_ROUNDS,
  parsePositiveInt,
  parsePositiveNumber,
} from "./config";
import { QUIPBENCH_MODELS } from "./models";
import type {
  BenchModel,
  MatchRecord,
  QuipbenchAi,
  QuipbenchRunResult,
  RatingState,
  VoteRecord,
} from "./types";
import { updatePairElo } from "./elo";
import { buildLeaderboard } from "./leaderboard";
import {
  finalizeRun,
  insertMatch,
  insertRunStart,
  openBenchDb,
  replaceRatings,
  updateRunProgress,
} from "./db";
import { exportLatestSnapshot } from "./export";

type RetryFn = <T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  retries: number,
  label: string,
) => Promise<T>;

function defaultIsRealString(value: string, minLength = 5): boolean {
  return value.trim().length >= minLength;
}

const defaultWithRetry: RetryFn = async (fn, validate, retries, label) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) return result;
      lastError = new Error(`${label}: validation failed`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label}: all retry attempts failed`);
};

async function loadLiveAi(): Promise<{
  ai: QuipbenchAi;
  retry: RetryFn;
  isRealStringFn: (value: string, minLength?: number) => boolean;
}> {
  const gameModule = await import("../game.ts");
  type GameModel = typeof gameModule.MODELS[number];

  function toGameModel(model: BenchModel): GameModel {
    return model as unknown as GameModel;
  }

  return {
    ai: {
      async generatePrompt(model) {
        return gameModule.callGeneratePrompt(toGameModel(model));
      },
      async generateAnswer(model, prompt) {
        return gameModule.callGenerateAnswer(toGameModel(model), prompt);
      },
      async vote(voter, prompt, answerA, answerB) {
        return gameModule.callVote(
          toGameModel(voter),
          prompt,
          { answer: answerA },
          { answer: answerB },
        );
      },
    },
    retry: gameModule.withRetry as RetryFn,
    isRealStringFn: gameModule.isRealString,
  };
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRng(seed: number, roundNum: number): () => number {
  const mixed = (seed ^ Math.imul(roundNum, 0x9e3779b1)) >>> 0;
  return mulberry32(mixed);
}

function shuffleWithRng<T>(items: T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const trimmed = raw.slice(2);
    const [key, ...rest] = trimmed.split("=");
    if (!key) continue;
    args[key] = rest.length === 0 ? "true" : rest.join("=");
  }
  return args;
}

function createRunId(): string {
  return `quipbench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type RoundRunResult = {
  match: MatchRecord;
};

async function runRound(options: {
  runId: string;
  roundNum: number;
  models: BenchModel[];
  ai: QuipbenchAi;
  seed: number;
  retry: RetryFn;
  isRealStringFn: (value: string, minLength?: number) => boolean;
}): Promise<RoundRunResult> {
  const { runId, roundNum, models, ai, seed, retry, isRealStringFn } = options;
  const rng = roundRng(seed, roundNum);
  const shuffled = shuffleWithRng(models, rng);

  const prompter = shuffled[0]!;
  const contestantA = shuffled[1]!;
  const contestantB = shuffled[2]!;
  const voters = [prompter, ...shuffled.slice(3)];

  const baseMatch: MatchRecord = {
    runId,
    roundNum,
    prompter,
    contestantA,
    contestantB,
    votesA: 0,
    votesB: 0,
    winner: "ERROR",
    votes: [],
  };

  let prompt = "";
  try {
    prompt = await retry(
      () => ai.generatePrompt(prompter),
      (value) => isRealStringFn(value, 10),
      3,
      `QB:R${roundNum}:prompt:${prompter.name}`,
    );
  } catch (error) {
    return {
      match: {
        ...baseMatch,
        winner: "ERROR",
        error:
          error instanceof Error
            ? `Prompt failed: ${error.message}`
            : "Prompt failed",
      },
    };
  }

  let answerA = "";
  let answerB = "";
  try {
    [answerA, answerB] = await Promise.all([
      retry(
        () => ai.generateAnswer(contestantA, prompt),
        (value) => isRealStringFn(value, 3),
        3,
        `QB:R${roundNum}:answer:${contestantA.name}`,
      ),
      retry(
        () => ai.generateAnswer(contestantB, prompt),
        (value) => isRealStringFn(value, 3),
        3,
        `QB:R${roundNum}:answer:${contestantB.name}`,
      ),
    ]);
  } catch (error) {
    return {
      match: {
        ...baseMatch,
        prompt,
        winner: "ERROR",
        error:
          error instanceof Error
            ? `Answer failed: ${error.message}`
            : "Answer failed",
      },
    };
  }

  const votes: VoteRecord[] = [];
  let votesA = 0;
  let votesB = 0;

  await Promise.all(
    voters.map(async (voter) => {
      const showAFirst = rng() > 0.5;
      const first = showAFirst ? answerA : answerB;
      const second = showAFirst ? answerB : answerA;

      try {
        const decision = await retry(
          () => ai.vote(voter, prompt, first, second),
          (value) => value === "A" || value === "B",
          3,
          `QB:R${roundNum}:vote:${voter.name}`,
        );

        const votedForA = showAFirst ? decision === "A" : decision === "B";
        if (votedForA) votesA += 1;
        else votesB += 1;

        votes.push({
          voterId: voter.id,
          voterName: voter.name,
          votedFor: votedForA ? "A" : "B",
          showAFirst,
        });
      } catch (error) {
        votes.push({
          voterId: voter.id,
          voterName: voter.name,
          votedFor: null,
          showAFirst,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  let winner: MatchRecord["winner"] = "TIE";
  if (votesA > votesB) winner = "A";
  else if (votesB > votesA) winner = "B";

  return {
    match: {
      ...baseMatch,
      prompt,
      answerA,
      answerB,
      votesA,
      votesB,
      winner,
      votes,
    },
  };
}

export type RunQuipbenchOptions = {
  rounds?: number;
  concurrency?: number;
  eloK?: number;
  initialElo?: number;
  seed?: number;
  outputDir?: string;
  dbPath?: string;
  models?: BenchModel[];
  ai?: QuipbenchAi;
};

export async function runQuipbench(
  options: RunQuipbenchOptions = {},
): Promise<QuipbenchRunResult> {
  const rounds = options.rounds ?? DEFAULT_ROUNDS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const eloK = options.eloK ?? DEFAULT_ELO_K;
  const initialElo = options.initialElo ?? DEFAULT_INITIAL_ELO;
  const models = options.models ?? QUIPBENCH_MODELS;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const seed = options.seed ?? Math.floor(Math.random() * 2_000_000_000);

  if (!options.ai && !process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for live Quipbench runs");
  }

  if (models.length < 3) {
    throw new Error("Quipbench requires at least 3 models");
  }

  if (rounds <= 0 || concurrency <= 0 || eloK <= 0 || initialElo <= 0) {
    throw new Error("rounds, concurrency, k, and initialElo must be positive");
  }

  let ai: QuipbenchAi = options.ai ?? {
    async generatePrompt() {
      throw new Error("Live AI is not loaded");
    },
    async generateAnswer() {
      throw new Error("Live AI is not loaded");
    },
    async vote() {
      throw new Error("Live AI is not loaded");
    },
  };
  let retry: RetryFn = defaultWithRetry;
  let isRealStringFn = defaultIsRealString;

  if (!options.ai) {
    const live = await loadLiveAi();
    ai = live.ai;
    retry = live.retry;
    isRealStringFn = live.isRealStringFn;
  }

  mkdirSync(outputDir, { recursive: true });

  const db = openBenchDb(dbPath);
  const runId = createRunId();
  const startedAt = new Date().toISOString();

  insertRunStart(db, {
    id: runId,
    startedAt,
    roundsRequested: rounds,
    concurrency,
    eloK,
    initialElo,
    seed,
    outputDir,
  });

  const ratings = new Map<string, RatingState>();
  for (const model of models) {
    ratings.set(model.id, {
      model,
      elo: initialElo,
      wins: 0,
      games: 0,
    });
  }

  let nextRound = 1;
  let roundsCompleted = 0;
  let failures = 0;

  let writeLock: Promise<void> = Promise.resolve();
  async function serializeWrite(fn: () => void | Promise<void>) {
    writeLock = writeLock.then(fn, fn);
    await writeLock;
  }

  async function worker() {
    while (true) {
      const roundNum = nextRound;
      nextRound += 1;
      if (roundNum > rounds) break;

      const { match } = await runRound({
        runId,
        roundNum,
        models,
        ai,
        seed,
        retry,
        isRealStringFn,
      });

      await serializeWrite(() => {
        insertMatch(db, match);

        if (match.winner === "ERROR") {
          failures += 1;
        } else {
          roundsCompleted += 1;

          const ratingA = ratings.get(match.contestantA.id);
          const ratingB = ratings.get(match.contestantB.id);
          if (!ratingA || !ratingB) {
            throw new Error("Contestant rating state missing");
          }

          ratingA.games += 1;
          ratingB.games += 1;

          let scoreA = 0.5;
          if (match.winner === "A") {
            scoreA = 1;
            ratingA.wins += 1;
          } else if (match.winner === "B") {
            scoreA = 0;
            ratingB.wins += 1;
          }

          const updated = updatePairElo(ratingA.elo, ratingB.elo, scoreA, eloK);
          ratingA.elo = updated.nextA;
          ratingB.elo = updated.nextB;
        }

        updateRunProgress(db, runId, { roundsCompleted, failures });
        process.stdout.write(
          `\rQuipbench progress: ${roundsCompleted + failures}/${rounds} (ok=${roundsCompleted}, failed=${failures})`,
        );
      });
    }
  }

  try {
    const workers = Array.from(
      { length: Math.min(concurrency, rounds) },
      () => worker(),
    );
    await Promise.all(workers);
    await writeLock;

    const leaderboard = buildLeaderboard(Array.from(ratings.values()));
    replaceRatings(db, runId, leaderboard);

    const endedAt = new Date().toISOString();
    finalizeRun(db, runId, "completed", endedAt);

    const snapshotPaths = await exportLatestSnapshot({
      dbPath,
      outputDir,
      runId,
    });

    process.stdout.write("\n");

    return {
      runMeta: {
        runId,
        startedAt,
        endedAt,
        roundsRequested: rounds,
        roundsCompleted,
        failures,
        concurrency,
        eloK,
        initialElo,
        seed,
      },
      leaderboard,
      snapshotPathJson: snapshotPaths.latestJsonPath,
      snapshotPathJs: snapshotPaths.latestJsPath,
    };
  } catch (error) {
    finalizeRun(db, runId, "failed", new Date().toISOString());
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rounds = parsePositiveInt(args.rounds, DEFAULT_ROUNDS);
  const concurrency = parsePositiveInt(args.concurrency, DEFAULT_CONCURRENCY);
  const eloK = parsePositiveNumber(args.k, DEFAULT_ELO_K);
  const initialElo = parsePositiveNumber(args.initialElo, DEFAULT_INITIAL_ELO);
  const seedArg = args.seed ? Number.parseInt(args.seed, 10) : undefined;
  const seed = Number.isFinite(seedArg) ? seedArg : undefined;

  const outputDir = args.out ? join(process.cwd(), args.out) : DEFAULT_OUTPUT_DIR;
  const dbPath = args.db ? join(process.cwd(), args.db) : DEFAULT_DB_PATH;

  const result = await runQuipbench({
    rounds,
    concurrency,
    eloK,
    initialElo,
    seed,
    outputDir,
    dbPath,
  });

  console.log("Quipbench complete");
  console.log(`Run ID: ${result.runMeta.runId}`);
  console.log(
    `Rounds: ${result.runMeta.roundsCompleted}/${result.runMeta.roundsRequested} (failures=${result.runMeta.failures})`,
  );
  console.log(`Snapshot JSON: ${result.snapshotPathJson}`);
  console.log(`Snapshot JS: ${result.snapshotPathJs}`);

  const preview = result.leaderboard.slice(0, 10);
  for (const row of preview) {
    console.log(
      `${String(row.rank).padStart(2)}. ${row.modelName.padEnd(20)} Elo ${row.elo.toFixed(2).padStart(8)} | ${row.wins}/${row.games} (${row.winRate.toFixed(2)}%)`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
