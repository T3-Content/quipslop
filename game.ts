import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

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
  streaks: Record<string, number>;
  viewerScores: Record<string, number>;
  done: boolean;
  isPaused: boolean;
  generation: number;
};

// ── OpenRouter ──────────────────────────────────────────────────────────────

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  extraBody: {
    reasoning: {
      effort: "medium",
    },
  },
});

// ── Logger ──────────────────────────────────────────────────────────────────

const LOGS_DIR = join(import.meta.dir, "logs");
mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = join(
  LOGS_DIR,
  `game-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

export { LOG_FILE };

export function log(
  level: "INFO" | "WARN" | "ERROR",
  category: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const ts = new Date().toISOString();
  let line = `[${ts}] ${level} [${category}] ${message}`;
  if (data) {
    line += " " + JSON.stringify(data);
  }
  appendFileSync(LOG_FILE, line + "\n");
  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  retries = 3,
  label = "unknown",
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) {
        log("INFO", label, `Success on attempt ${attempt}`, {
          result: typeof result === "string" ? result : String(result),
        });
        return result;
      }
      const msg = `Validation failed (attempt ${attempt}/${retries})`;
      log("WARN", label, msg, {
        result: typeof result === "string" ? result : String(result),
      });
      lastErr = new Error(`${msg}: ${JSON.stringify(result).slice(0, 100)}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("WARN", label, `Error on attempt ${attempt}/${retries}: ${errMsg}`, {
        error: errMsg,
        stack: err instanceof Error ? err.stack : undefined,
      });
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  log("ERROR", label, `All ${retries} attempts failed`, {
    lastError: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  throw lastErr;
}

export function isRealString(s: string, minLength = 5): boolean {
  return s.length >= minLength;
}

export function cleanResponse(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ── AI functions ────────────────────────────────────────────────────────────

import { ALL_PROMPTS } from "./prompts";

function buildPromptSystem(): string {
  const examples = shuffle([...ALL_PROMPTS]).slice(0, 80);
  return `You are a comedy writer for the game Quiplash. Generate a single funny fill-in-the-blank prompt that players will try to answer. The prompt should be surprising and designed to elicit hilarious responses. Return ONLY the prompt text, nothing else. Keep it short (under 15 words).

Use a wide VARIETY of prompt formats. Do NOT always use "The worst thing to..." — mix it up! Here are examples of the range of styles:

${examples.map((p) => `- ${p}`).join("\n")}

Come up with something ORIGINAL — don't copy these examples.`;
}

export async function callGeneratePrompt(model: Model): Promise<string> {
  log("INFO", `prompt:${model.name}`, "Calling API", { modelId: model.id });
  const system = buildPromptSystem();
  const { text, usage, reasoning } = await generateText({
    model: openrouter.chat(model.id),
    system,
    prompt:
      "Generate a single original Quiplash prompt. Be creative and don't repeat common patterns.",
  });

  log("INFO", `prompt:${model.name}`, "Raw response", {
    rawText: text,
    usage,
  });
  return cleanResponse(text);
}

export async function callGenerateAnswer(
  model: Model,
  prompt: string,
): Promise<string> {
  log("INFO", `answer:${model.name}`, "Calling API", {
    modelId: model.id,
    prompt,
  });
  const { text, usage, reasoning } = await generateText({
    model: openrouter.chat(model.id),
    system: `You are playing Quiplash! You'll be given a fill-in-the-blank prompt. Give the FUNNIEST possible answer. Be creative, edgy, unexpected, and concise. Reply with ONLY your answer — no quotes, no explanation, no preamble. Keep it short (under 12 words). Keep it concise and witty.`,
    prompt: `Fill in the blank: ${prompt}`,
  });

  log("INFO", `answer:${model.name}`, "Raw response", {
    rawText: text,
    usage,
  });
  return cleanResponse(text);
}

export async function callVote(
  voter: Model,
  prompt: string,
  a: { answer: string },
  b: { answer: string },
): Promise<"A" | "B"> {
  log("INFO", `vote:${voter.name}`, "Calling API", {
    modelId: voter.id,
    prompt,
    answerA: a.answer,
    answerB: b.answer,
  });
  const { text, usage, reasoning } = await generateText({
    model: openrouter.chat(voter.id),
    system: `You are a judge in a comedy game. You'll see a fill-in-the-blank prompt and two answers. Pick which answer is FUNNIER. You MUST respond with exactly "A" or "B" — nothing else.`,
    prompt: `Prompt: "${prompt}"\n\nAnswer A: "${a.answer}"\nAnswer B: "${b.answer}"\n\nWhich is funnier? Reply with just A or B.`,
  });

  log("INFO", `vote:${voter.name}`, "Raw response", { rawText: text, usage });
  const cleaned = text.trim().toUpperCase();
  if (!cleaned.startsWith("A") && !cleaned.startsWith("B")) {
    throw new Error(`Invalid vote: "${text.trim()}"`);
  }
  return cleaned.startsWith("A") ? "A" : "B";
}

import { saveRound } from "./db.ts";

// ── Game loop ───────────────────────────────────────────────────────────────

export async function runGame(
  runs: number,
  state: GameState,
  rerender: () => void,
  onViewerVotingStart?: (round: RoundState) => void,
) {
  let startRound = 1;
  const lastCompletedRound = state.completed.at(-1);
  if (lastCompletedRound) {
    startRound = lastCompletedRound.num + 1;
  }
  
  let endRound = startRound + runs - 1;
  
  for (let r = startRound; r <= endRound; r++) {
    while (state.isPaused) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const roundGeneration = state.generation;

    // Reset round counter if generation changed (e.g. admin reset)
    const latest = state.completed.at(-1);
    const expectedR = latest ? latest.num + 1 : 1;
    if (r !== expectedR) {
      r = expectedR;
      endRound = r + runs - 1;
    }

    const shuffled = shuffle([...MODELS]);
    const prompter = shuffled[0]!;
    const contA = shuffled[1]!;
    const contB = shuffled[2]!;
    const voters = [prompter, ...shuffled.slice(3)];
    const now = Date.now();

    const round: RoundState = {
      num: r,
      phase: "prompting",
      prompter,
      promptTask: { model: prompter, startedAt: now },
      contestants: [contA, contB],
      answerTasks: [
        { model: contA, startedAt: 0 },
        { model: contB, startedAt: 0 },
      ],
      votes: [],
    };
    state.active = round;
    log("INFO", "round", `=== Round ${r}/${runs} ===`, {
      prompter: prompter.name,
      contestants: [contA.name, contB.name],
      voters: voters.map((v) => v.name),
    });
    rerender();

    // ── Prompt phase ──
    try {
      const prompt = await withRetry(
        () => callGeneratePrompt(prompter),
        (s) => isRealString(s, 10),
        3,
        `R${r}:prompt:${prompter.name}`,
      );
      if (state.generation !== roundGeneration) {
        continue;
      }
      round.promptTask.finishedAt = Date.now();
      round.promptTask.result = prompt;
      round.prompt = prompt;
      rerender();
    } catch {
      if (state.generation !== roundGeneration) {
        continue;
      }
      round.promptTask.finishedAt = Date.now();
      round.promptTask.error = "Failed after 3 attempts";
      round.phase = "done";
      state.completed = [...state.completed, round];
      state.active = null;
      rerender();
      continue;
    }

    // ── Answer phase ──
    round.phase = "answering";
    const answerStart = Date.now();
    round.answerTasks[0].startedAt = answerStart;
    round.answerTasks[1].startedAt = answerStart;
    rerender();

    await Promise.all(
      round.answerTasks.map(async (task) => {
        if (state.generation !== roundGeneration) {
          return;
        }
        try {
          const answer = await withRetry(
            () => callGenerateAnswer(task.model, round.prompt!),
            (s) => isRealString(s, 3),
            3,
            `R${r}:answer:${task.model.name}`,
          );
          if (state.generation !== roundGeneration) {
            return;
          }
          task.result = answer;
        } catch {
          if (state.generation !== roundGeneration) {
            return;
          }
          task.error = "Failed to answer";
          task.result = "[no answer]";
        }
        if (state.generation !== roundGeneration) {
          return;
        }
        task.finishedAt = Date.now();
        rerender();
      }),
    );
    if (state.generation !== roundGeneration) {
      continue;
    }

    // ── Vote phase ──
    round.phase = "voting";
    const answerA = round.answerTasks[0].result!;
    const answerB = round.answerTasks[1].result!;
    const voteStart = Date.now();
    round.votes = voters.map((v) => ({ voter: v, startedAt: voteStart }));

    // Initialize viewer voting
    round.viewerVotesA = 0;
    round.viewerVotesB = 0;
    round.viewerVotingEndsAt = Date.now() + 30_000;
    onViewerVotingStart?.(round);
    rerender();

    await Promise.all([
      // Model votes
      Promise.all(
      round.votes.map(async (vote) => {
        if (state.generation !== roundGeneration) {
          return;
        }
        try {
          const showAFirst = Math.random() > 0.5;
          const first = showAFirst ? { answer: answerA } : { answer: answerB };
          const second = showAFirst ? { answer: answerB } : { answer: answerA };

          const result = await withRetry(
            () => callVote(vote.voter, round.prompt!, first, second),
            (v) => v === "A" || v === "B",
            3,
            `R${r}:vote:${vote.voter.name}`,
          );
          if (state.generation !== roundGeneration) {
            return;
          }
          const votedFor = showAFirst
            ? result === "A"
              ? contA
              : contB
            : result === "A"
              ? contB
              : contA;

          vote.finishedAt = Date.now();
          vote.votedFor = votedFor;
        } catch {
          if (state.generation !== roundGeneration) {
            return;
          }
          vote.finishedAt = Date.now();
          vote.error = true;
        }
        if (state.generation !== roundGeneration) {
          return;
        }
        rerender();
      }),
    ),
      // 30-second viewer voting window
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
    if (state.generation !== roundGeneration) {
      continue;
    }

    // ── Score ──
    let votesA = 0;
    let votesB = 0;
    for (const v of round.votes) {
      if (v.votedFor === contA) votesA++;
      else if (v.votedFor === contB) votesB++;
    }
    round.scoreA = votesA * 100;
    round.scoreB = votesB * 100;
    round.phase = "done";
    if (votesA > votesB) {
      state.scores[contA.name] = (state.scores[contA.name] || 0) + 1;
      state.streaks[contA.name] = (state.streaks[contA.name] || 0) + 1;
      state.streaks[contB.name] = 0;
    } else if (votesB > votesA) {
      state.scores[contB.name] = (state.scores[contB.name] || 0) + 1;
      state.streaks[contB.name] = (state.streaks[contB.name] || 0) + 1;
      state.streaks[contA.name] = 0;
    } else {
      state.streaks[contA.name] = 0;
      state.streaks[contB.name] = 0;
    }
    // Viewer vote scoring
    const vvA = round.viewerVotesA ?? 0;
    const vvB = round.viewerVotesB ?? 0;
    if (vvA > vvB) {
      state.viewerScores[contA.name] = (state.viewerScores[contA.name] || 0) + 1;
    } else if (vvB > vvA) {
      state.viewerScores[contB.name] = (state.viewerScores[contB.name] || 0) + 1;
    }
    rerender();

    await new Promise((r) => setTimeout(r, 5000));
    if (state.generation !== roundGeneration) {
      continue;
    }

    // Archive round
    saveRound(round);
    state.completed = [...state.completed, round];
    state.active = null;
    rerender();
  }

  state.done = true;
  rerender();
}
