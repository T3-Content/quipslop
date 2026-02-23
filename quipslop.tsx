import { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, Static, useApp } from "ink";
import {
  MODELS,
  MODEL_COLORS,
  NAME_PAD,
  LOG_FILE,
  log,
  runGame,
  type Model,
  type TaskInfo,
  type VoteInfo,
  type RoundState,
  type GameState,
} from "./game.ts";
import { createEmptyStreaks, type StreakMap } from "./streaks.ts";

// ── Components ──────────────────────────────────────────────────────────────

function Timer({
  startedAt,
  finishedAt,
}: {
  startedAt: number;
  finishedAt?: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (finishedAt) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [finishedAt]);
  const elapsed = ((finishedAt ?? now) - startedAt) / 1000;
  return <Text dimColor>({elapsed.toFixed(1)}s)</Text>;
}

function MName({ model, pad }: { model: Model; pad?: boolean }) {
  const name = pad ? model.name.padEnd(NAME_PAD) : model.name;
  return (
    <Text bold color={MODEL_COLORS[model.name]}>
      {name}
    </Text>
  );
}

function RoundView({ round, total }: { round: RoundState; total: number }) {
  const [contA, contB] = round.contestants;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Header */}
      <Box>
        <Text bold backgroundColor="blueBright" color="black">
          {` ROUND ${round.num}${total !== Infinity && total !== null ? `/${total}` : ""} `}
        </Text>
      </Box>
      <Text dimColor>{"─".repeat(50)}</Text>

      {/* Prompt */}
      <Box marginTop={1} gap={1}>
        <Text bold backgroundColor="magentaBright" color="black">
          {" PROMPT "}
        </Text>
        <MName model={round.prompter} />
        {!round.prompt && <Text dimColor>writing a prompt...</Text>}
        <Timer
          startedAt={round.promptTask.startedAt}
          finishedAt={round.promptTask.finishedAt}
        />
      </Box>
      {round.promptTask.error && (
        <Box marginLeft={2}>
          <Text color="red">✗ {round.promptTask.error}</Text>
        </Box>
      )}
      {round.prompt && (
        <Box marginLeft={2} marginTop={1}>
          <Text bold color="yellow">
            "{round.prompt}"
          </Text>
        </Box>
      )}

      {/* Answers */}
      {round.phase !== "prompting" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold backgroundColor="cyanBright" color="black">
            {" ANSWERS "}
          </Text>
          {round.answerTasks.map((task, i) => (
            <Box key={i} marginLeft={2} gap={1}>
              <MName model={task.model} pad />
              {!task.finishedAt ? (
                <Text dimColor>thinking...</Text>
              ) : task.error ? (
                <Text color="red">✗ {task.error}</Text>
              ) : (
                <Text bold>"{task.result}"</Text>
              )}
              {task.startedAt > 0 && (
                <Timer
                  startedAt={task.startedAt}
                  finishedAt={task.finishedAt}
                />
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Votes */}
      {(round.phase === "voting" || round.phase === "done") && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold backgroundColor="yellowBright" color="black">
            {" VOTES "}
          </Text>
          {round.votes.map((vote, i) => (
            <Box key={i} marginLeft={2} gap={1}>
              <MName model={vote.voter} pad />
              {!vote.finishedAt ? (
                <Text dimColor>voting...</Text>
              ) : vote.error || !vote.votedFor ? (
                <Text color="red">✗ failed</Text>
              ) : (
                <Text>
                  {"→ "}
                  <MName model={vote.votedFor} />
                </Text>
              )}
              <Timer startedAt={vote.startedAt} finishedAt={vote.finishedAt} />
            </Box>
          ))}
        </Box>
      )}

      {/* Round result */}
      {round.phase === "done" &&
        round.scoreA !== undefined &&
        round.scoreB !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{"─".repeat(50)}</Text>
            <Box marginLeft={2} gap={1}>
              {round.scoreA > round.scoreB ? (
                <Text>
                  <MName model={contA} />{" "}
                  <Text bold>
                    wins! ({round.scoreA / 100} vs {round.scoreB / 100} votes)
                  </Text>
                </Text>
              ) : round.scoreB > round.scoreA ? (
                <Text>
                  <MName model={contB} />{" "}
                  <Text bold>
                    wins! ({round.scoreB / 100} vs {round.scoreA / 100} votes)
                  </Text>
                </Text>
              ) : (
                <Text bold>
                  TIE! ({round.scoreA / 100} - {round.scoreB / 100})
                </Text>
              )}
            </Box>
            <Box marginLeft={2} gap={1}>
              <MName model={contA} />
              <Text dimColor>+{round.scoreA}</Text>
              <Text dimColor>|</Text>
              <MName model={contB} />
              <Text dimColor>+{round.scoreB}</Text>
            </Box>
            <Text dimColor>{"─".repeat(50)}</Text>
          </Box>
        )}
    </Box>
  );
}

function Scoreboard({
  scores,
  streaks,
}: {
  scores: Record<string, number>;
  streaks: StreakMap;
}) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const maxScore = sorted[0]?.[1] || 1;
  const barWidth = 30;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold backgroundColor="magentaBright" color="black">
        {" FINAL SCORES "}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {sorted.map(([name, score], i) => {
          const streak = streaks[name] ?? { current: 0 };
          const filled = Math.round((score / maxScore) * barWidth);
          const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
          const medal =
            i === 0 ? " 👑" : i === 1 ? " 🥈" : i === 2 ? " 🥉" : "";
          return (
            <Box key={name} marginLeft={2} gap={1}>
              <Text>{String(i + 1).padStart(2)}.</Text>
              <Text bold color={MODEL_COLORS[name]}>
                {name.padEnd(NAME_PAD)}
              </Text>
              <Text color={MODEL_COLORS[name]}>{bar}</Text>
              <Text bold>
                {score} {score === 1 ? "win" : "wins"}
              </Text>
              {streak.current >= 2 && <Text dimColor>🔥 {streak.current}</Text>}
              <Text>{medal}</Text>
            </Box>
          );
        })}
      </Box>
      {sorted[0] && sorted[0][1] > 0 && (
        <Box marginTop={1} marginLeft={2}>
          <Text>
            {"🏆 "}
            <Text bold color={MODEL_COLORS[sorted[0][0]]}>
              {sorted[0][0]}
            </Text>
            <Text bold> is the funniest AI!</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

function Game({ runs }: { runs: number }) {
  const stateRef = useRef<GameState>({
    completed: [],
    active: null,
    scores: Object.fromEntries(MODELS.map((m) => [m.name, 0])),
    streaks: createEmptyStreaks(MODELS.map((m) => m.name)),
    done: false,
    isPaused: false,
    generation: 0,
  });
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    runGame(runs, stateRef.current, rerender).then(() => {
      setTimeout(() => process.exit(0), 200);
    });
  }, []);

  const state = stateRef.current;

  return (
    <Box flexDirection="column">
      <Static items={state.completed}>
        {(round: RoundState) => (
          <RoundView key={round.num} round={round} total={runs} />
        )}
      </Static>

      {state.active && <RoundView round={state.active} total={runs} />}

      {state.done && <Scoreboard scores={state.scores} streaks={state.streaks} />}
      {state.done && (
        <Box marginTop={1}>
          <Text dimColor>Log: {LOG_FILE}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

const runsArg = process.argv.find((a) => a.startsWith("runs="));
const runsVal = runsArg ? runsArg.split("=")[1] : "infinite";
const runs =
  runsVal === "infinite" ? Infinity : parseInt(runsVal || "infinite", 10);

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: Set OPENROUTER_API_KEY environment variable");
  process.exit(1);
}

log("INFO", "startup", `Game starting: ${runs} rounds`, {
  models: MODELS.map((m) => m.id),
});

console.log(
  `\n\x1b[1m\x1b[45m\x1b[30m quipslop \x1b[0m \x1b[2m${runs} rounds\x1b[0m`,
);
console.log(`\x1b[2mModels: ${MODELS.map((m) => m.name).join(", ")}\x1b[0m\n`);

render(<Game runs={runs} />);
