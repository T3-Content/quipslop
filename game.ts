import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { BunFileSystem } from "@effect/platform-bun";
import {
  Config,
  Data,
  Effect,
  flow,
  Layer,
  Logger,
  pipe,
  Random,
  ServiceMap,
} from "effect";
import { ALL_PROMPTS } from "./prompts";
import { LanguageModel } from "effect/unstable/ai";
import { saveRound } from "./db";
import { FetchHttpClient } from "effect/unstable/http";
import * as Path from "node:path";

export const runGame = (
  runs: number,
  state: GameState,
  rerender: () => void,
  onViewerVotingStart?: () => void,
) =>
  Effect.runPromise(runGameEffect(runs, state, rerender, onViewerVotingStart));

export const runGameEffect = Effect.fn("runGame")(
  function* (
    runs: number,
    state: GameState,
    rerender: () => void,
    onViewerVotingStart?: () => void,
  ) {
    yield* Effect.logInfo("startup", `Game starting: ${runs} rounds`, {
      models: MODELS.map((m) => m.id),
    });

    let startRound = 1;
    const lastCompletedRound = state.completed.at(-1);
    if (lastCompletedRound) {
      startRound = lastCompletedRound.num + 1;
    }
    let endRound = startRound + runs - 1;

    for (let r = startRound; r <= endRound; r++) {
      const roundGeneration = state.generation;

      const update = (f: () => void) =>
        Effect.suspend(() => {
          if (state.generation !== roundGeneration) {
            return Effect.interrupt;
          }
          f();
          rerender();
          return Effect.void;
        });

      yield* runRound(runs, r, state, update, onViewerVotingStart).pipe(
        Effect.ignoreCause({ log: "Error" }),
        Effect.annotateLogs({ round: r }),
      );
    }
  },
  (effect) => Effect.provide(effect, EnvLayer),
);

const runRound = Effect.fn("runRound")(function* (
  runs: number,
  r: number,
  state: GameState,
  update: (f: () => void) => Effect.Effect<void>,
  onViewerVotingStart?: () => void,
) {
  while (state.isPaused) {
    yield* Effect.sleep(1000);
  }

  const gen = yield* GameGeneration;
  const models = yield* Random.shuffle(MODELS);
  const prompter = models[0]!;
  const contestants: [Model, Model] = [models[1]!, models[2]!] as const;
  const voters = [prompter, ...models.slice(3)];
  const now = Date.now();

  const round: RoundState = {
    num: r,
    phase: "prompting",
    prompter,
    promptTask: { model: prompter, startedAt: now },
    contestants,
    answerTasks: [
      { model: contestants[0], startedAt: 0 },
      { model: contestants[1], startedAt: 0 },
    ],
    votes: [],
  };
  yield* update(() => {
    state.active = round;
  });
  yield* Effect.logInfo(`=== Round ${r}/${runs} ===`, {
    prompter: prompter.name,
    contestants: [contestants[0].name, contestants[1].name],
    voters: voters.map((v) => v.name),
  });

  // ── Prompt phase ──
  const prompt = yield* gen.generatePrompt.pipe(
    withModel(prompter),
    Effect.onError(() =>
      update(() => {
        round.promptTask.finishedAt = Date.now();
        round.promptTask.error = "Failed after 3 attempts";
        round.phase = "done";
        state.completed = [...state.completed, round];
        state.active = null;
      }),
    ),
  );
  yield* update(() => {
    round.promptTask.finishedAt = Date.now();
    round.promptTask.result = prompt;
    round.prompt = prompt;
  });

  // ── Answer phase ──
  const answerStart = Date.now();
  yield* update(() => {
    round.phase = "answering";
    round.answerTasks[0].startedAt = answerStart;
    round.answerTasks[1].startedAt = answerStart;
  });

  yield* Effect.forEach(
    round.answerTasks,
    Effect.fn(function* (task) {
      task.result = yield* gen.generateAnswer(prompt).pipe(
        withModel(task.model),
        Effect.onError(() => {
          task.error = "Failed to answer";
          task.result = "[no answer]";
          return Effect.void;
        }),
      );
      yield* update(() => {
        task.finishedAt = Date.now();
      });
    }),
    { concurrency: "unbounded", discard: true },
  );

  // ── Vote phase ──
  const answerA = round.answerTasks[0].result!;
  const answerB = round.answerTasks[1].result!;
  const voteStart = Date.now();
  yield* update(() => {
    round.phase = "voting";
    round.votes = voters.map((v) => ({ voter: v, startedAt: voteStart }));
    round.viewerVotesA = 0;
    round.viewerVotesB = 0;
    round.viewerVotingEndsAt = Date.now() + 30_000;
  });
  if (onViewerVotingStart) {
    onViewerVotingStart();
  }
  const showAFirst = (yield* Random.next) > 0.5;

  yield* Effect.all(
    [
      // Model votes
      Effect.forEach(
        round.votes,
        Effect.fn(function* (vote) {
          yield* pipe(
            gen.generateVote({
              prompt,
              answerA: showAFirst ? answerA : answerB,
              answerB: showAFirst ? answerB : answerA,
            }),
            withModel(vote.voter),
            Effect.matchCause({
              onFailure(_) {
                vote.error = true;
              },
              onSuccess(result) {
                const reversed = showAFirst
                  ? contestants
                  : ([...contestants].reverse() as [Model, Model]);
                const votedFor = result === "A" ? reversed[0] : reversed[1];
                vote.votedFor = votedFor;
              },
            }),
          );
          yield* update(() => {
            vote.finishedAt = Date.now();
          });
        }),
        { concurrency: "unbounded", discard: true },
      ),
      // 30-second viewer voting window
      Effect.sleep(30_000),
    ],
    { concurrency: "unbounded", discard: true },
  );

  // ── Score ──
  yield* update(() => {
    let votesA = 0;
    let votesB = 0;
    for (const v of round.votes) {
      if (v.votedFor === contestants[0]) votesA++;
      else if (v.votedFor === contestants[1]) votesB++;
    }
    round.scoreA = votesA * 100;
    round.scoreB = votesB * 100;
    round.phase = "done";
    if (votesA > votesB) {
      state.scores[contestants[0].name] =
        (state.scores[contestants[0].name] || 0) + 1;
    } else if (votesB > votesA) {
      state.scores[contestants[1].name] =
        (state.scores[contestants[1].name] || 0) + 1;
    }
    // Viewer vote scoring
    const vvA = round.viewerVotesA ?? 0;
    const vvB = round.viewerVotesB ?? 0;
    if (vvA > vvB) {
      state.viewerScores[contestants[0].name] =
        (state.viewerScores[contestants[0].name] || 0) + 1;
    } else if (vvB > vvA) {
      state.viewerScores[contestants[1].name] =
        (state.viewerScores[contestants[1].name] || 0) + 1;
    }
  });

  yield* Effect.sleep(5000);

  // Archive round
  saveRound(round);
  yield* update(() => {
    state.completed = [...state.completed, round];
    state.active = null;
  });
});

export class GameGeneration extends ServiceMap.Service<GameGeneration>()(
  "quipslop/game-effect/GameGeneration",
  {
    make: Effect.gen(function* () {
      const ai = yield* LanguageModel.LanguageModel;

      const systemPrompt = Effect.gen(function* () {
        const examples = yield* Random.shuffle(ALL_PROMPTS);
        return `You are a comedy writer for the game Quiplash. Generate a single funny fill-in-the-blank prompt that players will try to answer. The prompt should be surprising and designed to elicit hilarious responses. Return ONLY the prompt text, nothing else. Keep it short (under 15 words).

Use a wide VARIETY of prompt formats. Do NOT always use "The worst thing to..." — mix it up! Here are examples of the range of styles:

${examples.map((p) => `- ${p}`).join("\n")}

Come up with something ORIGINAL — don't copy these examples.`;
      });

      const generatePrompt = Effect.gen(function* () {
        yield* Effect.logInfo("Calling api");
        const response = yield* ai.generateText({
          prompt: [
            { role: "system", content: yield* systemPrompt },
            {
              role: "user",
              content:
                "Generate a single original Quiplash prompt. Be creative and don't repeat common patterns.",
            },
          ],
        });
        yield* Effect.logInfo("Raw response", {
          rawText: response.text,
          usage: response.usage,
        });
        if (response.text.length <= 10) {
          return yield* new ResponseTooSmall();
        }
        return cleanResponse(response.text);
      }).pipe(
        Effect.retry({
          while: (e) =>
            (e._tag === "AiError" && e.isRetryable) ||
            e._tag === "ResponseTooSmall",
          times: 3,
        }),
        Effect.annotateLogs({
          method: "generatePrompt",
        }),
      );

      const generateAnswer = Effect.fn("generateAnswer")(
        function* (prompt: string) {
          yield* Effect.logInfo("Calling api");
          const response = yield* ai.generateText({
            prompt: [
              {
                role: "system",
                content: `You are playing Quiplash! You'll be given a fill-in-the-blank prompt. Give the FUNNIEST possible answer. Be creative, edgy, unexpected, and concise. Reply with ONLY your answer — no quotes, no explanation, no preamble. Keep it short (under 12 words). Keep it concise and witty.`,
              },
              {
                role: "user",
                content: `Fill in the blank: ${prompt}`,
              },
            ],
          });
          yield* Effect.logInfo("Raw response", {
            rawText: response.text,
            usage: response.usage,
          });
          if (response.text.length <= 3) {
            return yield* new ResponseTooSmall();
          }
          return cleanResponse(response.text);
        },
        Effect.retry({
          while: (e) =>
            (e._tag === "AiError" && e.isRetryable) ||
            e._tag === "ResponseTooSmall",
          times: 3,
        }),
        Effect.annotateLogs({ method: "generateAnswer" }),
      );

      const generateVote = Effect.fn("generateVote")(
        function* ({
          prompt,
          answerA,
          answerB,
        }: {
          readonly prompt: string;
          readonly answerA: string;
          readonly answerB: string;
        }) {
          yield* Effect.logInfo("Calling api");
          const response = yield* ai.generateText({
            prompt: [
              {
                role: "system",
                content: `You are a judge in a comedy game. You'll see a fill-in-the-blank prompt and two answers. Pick which answer is FUNNIER. You MUST respond with exactly "A" or "B" — nothing else.`,
              },
              {
                role: "user",
                content: `Prompt: "${prompt}"\n\nAnswer A: "${answerA}"\nAnswer B: "${answerB}"\n\nWhich is funnier? Reply with just A or B.`,
              },
            ],
          });
          yield* Effect.logInfo("Raw response", {
            rawText: response.text,
            usage: response.usage,
          });
          const cleaned = response.text.trim().toUpperCase();
          if (!cleaned.startsWith("A") && !cleaned.startsWith("B")) {
            return yield* new InvalidVote();
          }
          return cleaned.startsWith("A") ? "A" : "B";
        },
        Effect.retry({
          while: (e) =>
            (e._tag === "AiError" && e.isRetryable) || e._tag === "InvalidVote",
          times: 3,
        }),
        Effect.annotateLogs({ method: "generateVote" }),
      );

      return {
        generatePrompt,
        generateAnswer,
        generateVote,
      } as const;
    }),
  },
) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(
      OpenRouterLanguageModel.layer({
        model: "",
        config: {
          reasoning: {
            effort: "medium",
          },
          max_completion_tokens: 1000,
        },
      }),
    ),
    Layer.provide(
      OpenRouterClient.layerConfig({
        apiKey: Config.redacted("OPENROUTER_API_KEY"),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
}

// ── Models ──────────────────────────────────────────────────────────────────

export const MODELS = [
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
  { id: "moonshotai/kimi-k2", name: "Kimi K2" },
  // { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek 3.2" },
  // { id: "z-ai/glm-5", name: "GLM-5" },
  { id: "openai/gpt-5.2", name: "GPT-5.2" },
  { id: "anthropic/claude-opus-4.6", name: "Opus 4.6" },
  { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
  { id: "x-ai/grok-4.1-fast", name: "Grok 4.1" },
  // { id: "minimax/minimax-m2.5", name: "MiniMax 2.5" },
] as const;

export type Model = (typeof MODELS)[number];

export const MODEL_COLORS: Record<string, string> = {
  "Gemini 3.1 Pro": "cyan",
  "Kimi K2": "green",
  "Kimi K2.5": "magenta",
  "DeepSeek 3.2": "greenBright",
  "GLM-5": "cyanBright",
  "GPT-5.2": "yellow",
  "Opus 4.6": "blue",
  "Sonnet 4.6": "red",
  "Grok 4.1": "white",
  "MiniMax 2.5": "magentaBright",
};

export const NAME_PAD = 16;

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskInfo = {
  model: Model;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
};

export type VoteInfo = {
  voter: Model;
  startedAt: number;
  finishedAt?: number;
  votedFor?: Model;
  error?: boolean;
};

export type RoundState = {
  num: number;
  phase: "prompting" | "answering" | "voting" | "done";
  prompter: Model;
  promptTask: TaskInfo;
  prompt?: string;
  contestants: [Model, Model];
  answerTasks: [TaskInfo, TaskInfo];
  votes: VoteInfo[];
  scoreA?: number;
  scoreB?: number;
  viewerVotesA?: number;
  viewerVotesB?: number;
  viewerVotingEndsAt?: number;
};

export type GameState = {
  completed: RoundState[];
  active: RoundState | null;
  scores: Record<string, number>;
  viewerScores: Record<string, number>;
  done: boolean;
  isPaused: boolean;
  generation: number;
};

// ── Errors ──────────────────────────────────────────────────────────────────

export class ResponseTooSmall extends Data.TaggedError("ResponseTooSmall") {}
export class InvalidVote extends Data.TaggedError("InvalidVote") {}

// ── Utils ───────────────────────────────────────────────────────────────────

function cleanResponse(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const withModel = (model: Model) =>
  flow(
    OpenRouterLanguageModel.withConfigOverride({
      model: model.id,
    }),
    Effect.annotateLogs({
      modelId: model.id,
    }),
  );

// ── Logger ──────────────────────────────────────────────────────────────────

const LOGS_DIR = Path.join(import.meta.dir, "logs");
export const LOG_FILE = Path.join(
  LOGS_DIR,
  `game-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

const FileLogger = Logger.layer([
  Logger.toFile(Logger.formatLogFmt, LOG_FILE),
]).pipe(Layer.provide(BunFileSystem.layer));

const EnvLayer = GameGeneration.layer.pipe(Layer.provideMerge(FileLogger));
