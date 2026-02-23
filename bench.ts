import {
  MODELS,
  type Model,
  shuffle,
  withRetry,
  callGeneratePrompt,
  callGenerateAnswer,
  callVote,
  isRealString,
  log,
} from "./game.ts";
import {
  saveBenchRun,
  updateBenchRunStatus,
  saveBenchRound,
} from "./bench-db.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export type BenchPairing = {
  index: number;
  modelA: Model;
  modelB: Model;
};

export type BenchRoundResult = {
  pairingIndex: number;
  roundNum: number;
  prompter: Model;
  prompt: string;
  modelA: Model;
  answerA: string;
  modelB: Model;
  answerB: string;
  votes: { voter: Model; votedFor: "A" | "B" | null }[];
  votesA: number;
  votesB: number;
  winner: "A" | "B" | "tie";
  error?: string;
};

export type BenchRunConfig = {
  models: Model[];
  roundsPerPairing: number;
};

export type BenchRunState = {
  id: string;
  status: "running" | "completed" | "cancelled" | "error";
  config: BenchRunConfig;
  startedAt: number;
  finishedAt?: number;
  totalRounds: number;
  completedRounds: number;
  currentPairing?: BenchPairing;
  currentRound?: number;
  error?: string;
};

// ── State ──────────────────────────────────────────────────────────────────

let activeBenchRun: BenchRunState | null = null;
let cancelFlag = false;

export function getActiveBenchRun(): BenchRunState | null {
  return activeBenchRun;
}

export function cancelBench(): boolean {
  if (!activeBenchRun) return false;
  cancelFlag = true;
  return true;
}

// ── Pairing generation ─────────────────────────────────────────────────────

export function generatePairings(models: readonly Model[]): BenchPairing[] {
  const pairings: BenchPairing[] = [];
  let index = 0;
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      pairings.push({ index, modelA: models[i], modelB: models[j] });
      index++;
    }
  }
  return shuffle(pairings);
}

// ── Single round ───────────────────────────────────────────────────────────

async function runBenchRound(
  pairing: BenchPairing,
  roundNum: number,
  allModels: readonly Model[],
): Promise<BenchRoundResult> {
  const nonContestants = allModels.filter(
    (m) => m.id !== pairing.modelA.id && m.id !== pairing.modelB.id,
  );
  if (nonContestants.length === 0) {
    return {
      pairingIndex: pairing.index,
      roundNum,
      prompter: pairing.modelA,
      prompt: "",
      modelA: pairing.modelA,
      answerA: "",
      modelB: pairing.modelB,
      answerB: "",
      votes: [],
      votesA: 0,
      votesB: 0,
      winner: "tie",
      error: "Not enough models for prompter/voters",
    };
  }
  const shuffledNon = shuffle([...nonContestants]);
  const prompter = shuffledNon[0]!;
  const voters = shuffledNon; // all non-contestants vote (including prompter)

  const label = `Bench:P${pairing.index}R${roundNum}`;

  // Prompt phase
  let prompt: string;
  try {
    prompt = await withRetry(
      () => callGeneratePrompt(prompter),
      (s) => isRealString(s, 10),
      3,
      `${label}:prompt:${prompter.name}`,
    );
  } catch (err: any) {
    return {
      pairingIndex: pairing.index,
      roundNum,
      prompter,
      prompt: "",
      modelA: pairing.modelA,
      answerA: "",
      modelB: pairing.modelB,
      answerB: "",
      votes: [],
      votesA: 0,
      votesB: 0,
      winner: "tie",
      error: `Prompt failed: ${err.message}`,
    };
  }

  // Answer phase (parallel)
  let answerA = "",
    answerB = "";
  try {
    const [ansA, ansB] = await Promise.all([
      withRetry(
        () => callGenerateAnswer(pairing.modelA, prompt),
        (s) => isRealString(s, 3),
        3,
        `${label}:answer:${pairing.modelA.name}`,
      ),
      withRetry(
        () => callGenerateAnswer(pairing.modelB, prompt),
        (s) => isRealString(s, 3),
        3,
        `${label}:answer:${pairing.modelB.name}`,
      ),
    ]);
    answerA = ansA;
    answerB = ansB;
  } catch (err: any) {
    return {
      pairingIndex: pairing.index,
      roundNum,
      prompter,
      prompt,
      modelA: pairing.modelA,
      answerA,
      modelB: pairing.modelB,
      answerB,
      votes: [],
      votesA: 0,
      votesB: 0,
      winner: "tie",
      error: `Answer failed: ${err.message}`,
    };
  }

  // Vote phase (parallel)
  let votesA = 0;
  let votesB = 0;
  const roundVotes: { voter: Model; votedFor: "A" | "B" | null }[] = [];

  await Promise.all(
    voters.map(async (voter) => {
      try {
        const showAFirst = Math.random() > 0.5;
        const first = showAFirst
          ? { answer: answerA }
          : { answer: answerB };
        const second = showAFirst
          ? { answer: answerB }
          : { answer: answerA };

        const result = await withRetry(
          () => callVote(voter, prompt, first, second),
          (v) => v === "A" || v === "B",
          3,
          `${label}:vote:${voter.name}`,
        );

        const votedForA = showAFirst ? result === "A" : result === "B";
        if (votedForA) votesA++;
        else votesB++;
        roundVotes.push({ voter, votedFor: votedForA ? "A" : "B" });
      } catch {
        roundVotes.push({ voter, votedFor: null });
      }
    }),
  );

  const winner: "A" | "B" | "tie" =
    votesA > votesB ? "A" : votesB > votesA ? "B" : "tie";

  return {
    pairingIndex: pairing.index,
    roundNum,
    prompter,
    prompt,
    modelA: pairing.modelA,
    answerA,
    modelB: pairing.modelB,
    answerB,
    votes: roundVotes,
    votesA,
    votesB,
    winner,
  };
}

// ── Main bench loop ────────────────────────────────────────────────────────

export async function runBench(
  config: BenchRunConfig,
  onProgress: () => void,
): Promise<string> {
  if (activeBenchRun) {
    throw new Error("A benchmark is already running");
  }

  const models = config.models;
  const pairings = generatePairings(models);
  const totalRounds = pairings.length * config.roundsPerPairing;
  const runId = crypto.randomUUID();

  const state: BenchRunState = {
    id: runId,
    status: "running",
    config,
    startedAt: Date.now(),
    totalRounds,
    completedRounds: 0,
  };

  activeBenchRun = state;
  cancelFlag = false;

  saveBenchRun({
    id: runId,
    status: "running",
    config,
    startedAt: state.startedAt,
    totalRounds,
  });

  log("INFO", "bench", `Starting benchmark run ${runId}`, {
    pairings: pairings.length,
    roundsPerPairing: config.roundsPerPairing,
    totalRounds,
  });

  onProgress();

  try {
    for (let pi = 0; pi < pairings.length; pi++) {
      const pairing = pairings[pi]!;

      for (let rn = 1; rn <= config.roundsPerPairing; rn++) {
        if (cancelFlag) {
          state.status = "cancelled";
          state.finishedAt = Date.now();
          updateBenchRunStatus(runId, {
            status: "cancelled",
            completedRounds: state.completedRounds,
            finishedAt: state.finishedAt,
          });
          log("INFO", "bench", `Benchmark ${runId} cancelled`);
          onProgress();
          activeBenchRun = null;
          return runId;
        }

        state.currentPairing = pairing;
        state.currentRound = rn;
        onProgress();

        const result = await runBenchRound(pairing, rn, models);

        saveBenchRound({
          runId,
          pairingIndex: pairing.index,
          roundNum: rn,
          data: result,
        });

        state.completedRounds++;
        updateBenchRunStatus(runId, {
          completedRounds: state.completedRounds,
        });

        onProgress();
      }
    }

    state.status = "completed";
    state.finishedAt = Date.now();
    state.currentPairing = undefined;
    state.currentRound = undefined;
    updateBenchRunStatus(runId, {
      status: "completed",
      completedRounds: state.completedRounds,
      finishedAt: state.finishedAt,
    });

    log("INFO", "bench", `Benchmark ${runId} completed`, {
      completedRounds: state.completedRounds,
    });
    onProgress();
  } catch (err: any) {
    state.status = "error";
    state.error = err.message;
    state.finishedAt = Date.now();
    updateBenchRunStatus(runId, {
      status: "error",
      completedRounds: state.completedRounds,
      finishedAt: state.finishedAt,
      error: err.message,
    });
    log("ERROR", "bench", `Benchmark ${runId} failed`, {
      error: err.message,
    });
    onProgress();
  } finally {
    activeBenchRun = null;
  }

  return runId;
}
