import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./frontend.css";
import type { StreakMap } from "./streaks.ts";

// ── Types ────────────────────────────────────────────────────────────────────

type Model = { id: string; name: string };
type TaskInfo = {
  model: Model;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
};
type VoteInfo = {
  voter: Model;
  startedAt: number;
  finishedAt?: number;
  votedFor?: Model;
  error?: boolean;
};
type RoundState = {
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
};
type GameState = {
  lastCompleted: RoundState | null;
  active: RoundState | null;
  scores: Record<string, number>;
  streaks: StreakMap;
  done: boolean;
  isPaused: boolean;
  generation: number;
};
type StateMessage = {
  type: "state";
  data: GameState;
  totalRounds: number;
  viewerCount: number;
  version?: string;
};
type ViewerCountMessage = {
  type: "viewerCount";
  viewerCount: number;
};
type ServerMessage = StateMessage | ViewerCountMessage;

// ── Model colors & logos ─────────────────────────────────────────────────────

const MODEL_COLORS: Record<string, string> = {
  "Gemini 3.1 Pro": "#4285F4",
  "Kimi K2": "#00E599",
  "DeepSeek 3.2": "#4D6BFE",
  "GLM-5": "#1F63EC",
  "GPT-5.2": "#10A37F",
  "Opus 4.6": "#D97757",
  "Sonnet 4.6": "#D97757",
  "Grok 4.1": "#FFFFFF",
  "MiniMax 2.5": "#FF3B30",
};

function getColor(name: string): string {
  return MODEL_COLORS[name] ?? "#A1A1A1";
}

function getLogo(name: string): string | null {
  if (name.includes("Gemini")) return "/assets/logos/gemini.svg";
  if (name.includes("Kimi")) return "/assets/logos/kimi.svg";
  if (name.includes("DeepSeek")) return "/assets/logos/deepseek.svg";
  if (name.includes("GLM")) return "/assets/logos/glm.svg";
  if (name.includes("GPT")) return "/assets/logos/openai.svg";
  if (name.includes("Opus") || name.includes("Sonnet"))
    return "/assets/logos/claude.svg";
  if (name.includes("Grok")) return "/assets/logos/grok.svg";
  if (name.includes("MiniMax")) return "/assets/logos/minimax.svg";
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Dots() {
  return (
    <span className="dots">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

function ModelTag({ model, small }: { model: Model; small?: boolean }) {
  const logo = getLogo(model.name);
  const color = getColor(model.name);
  return (
    <span
      className={`model-tag ${small ? "model-tag--sm" : ""}`}
      style={{ color }}
    >
      {logo && <img src={logo} alt="" className="model-tag__logo" />}
      {model.name}
    </span>
  );
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function PromptCard({ round }: { round: RoundState }) {
  if (round.phase === "prompting" && !round.prompt) {
    return (
      <div className="prompt">
        <div className="prompt__by">
          <ModelTag model={round.prompter} small /> is writing a prompt
          <Dots />
        </div>
        <div className="prompt__text prompt__text--loading">
          <Dots />
        </div>
      </div>
    );
  }

  if (round.promptTask.error) {
    return (
      <div className="prompt">
        <div className="prompt__text prompt__text--error">
          Prompt generation failed
        </div>
      </div>
    );
  }

  return (
    <div className="prompt">
      <div className="prompt__by">
        Prompted by <ModelTag model={round.prompter} small />
      </div>
      <div className="prompt__text">{round.prompt}</div>
    </div>
  );
}

// ── Contestant ───────────────────────────────────────────────────────────────

function ContestantCard({
  task,
  voteCount,
  totalVotes,
  isWinner,
  showVotes,
  voters,
}: {
  task: TaskInfo;
  voteCount: number;
  totalVotes: number;
  isWinner: boolean;
  showVotes: boolean;
  voters: VoteInfo[];
}) {
  const color = getColor(task.model.name);
  const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;

  return (
    <div
      className={`contestant ${isWinner ? "contestant--winner" : ""}`}
      style={{ "--accent": color } as React.CSSProperties}
    >
      <div className="contestant__head">
        <ModelTag model={task.model} />
        {isWinner && <span className="win-tag">WIN</span>}
      </div>

      <div className="contestant__body">
        {!task.finishedAt ? (
          <p className="answer answer--loading">
            <Dots />
          </p>
        ) : task.error ? (
          <p className="answer answer--error">{task.error}</p>
        ) : (
          <p className="answer">&ldquo;{task.result}&rdquo;</p>
        )}
      </div>

      {showVotes && (
        <div className="contestant__foot">
          <div className="vote-bar">
            <div
              className="vote-bar__fill"
              style={{ width: `${pct}%`, background: color }}
            />
          </div>
          <div className="vote-meta">
            <span className="vote-meta__count" style={{ color }}>
              {voteCount}
            </span>
            <span className="vote-meta__label">
              vote{voteCount !== 1 ? "s" : ""}
            </span>
            <span className="vote-meta__dots">
              {voters.map((v, i) => {
                const logo = getLogo(v.voter.name);
                return logo ? (
                  <img
                    key={i}
                    src={logo}
                    alt={v.voter.name}
                    title={v.voter.name}
                    className="voter-dot"
                  />
                ) : (
                  <span
                    key={i}
                    className="voter-dot voter-dot--letter"
                    style={{ color: getColor(v.voter.name) }}
                    title={v.voter.name}
                  >
                    {v.voter.name[0]}
                  </span>
                );
              })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Arena ─────────────────────────────────────────────────────────────────────

function Arena({ round, total }: { round: RoundState; total: number | null }) {
  const [contA, contB] = round.contestants;
  const showVotes = round.phase === "voting" || round.phase === "done";
  const isDone = round.phase === "done";

  let votesA = 0,
    votesB = 0;
  for (const v of round.votes) {
    if (v.votedFor?.name === contA.name) votesA++;
    else if (v.votedFor?.name === contB.name) votesB++;
  }
  const totalVotes = votesA + votesB;
  const votersA = round.votes.filter((v) => v.votedFor?.name === contA.name);
  const votersB = round.votes.filter((v) => v.votedFor?.name === contB.name);

  const phaseText =
    round.phase === "prompting"
      ? "Writing prompt"
      : round.phase === "answering"
        ? "Answering"
        : round.phase === "voting"
          ? "Judges voting"
          : "Complete";

  return (
    <div className="arena">
      <div className="arena__meta">
        <span className="arena__round">
          Round {round.num}
          {total ? <span className="dim">/{total}</span> : null}
        </span>
        <span className="arena__phase">{phaseText}</span>
      </div>

      <PromptCard round={round} />

      {round.phase !== "prompting" && (
        <div className="showdown">
          <ContestantCard
            task={round.answerTasks[0]}
            voteCount={votesA}
            totalVotes={totalVotes}
            isWinner={isDone && votesA > votesB}
            showVotes={showVotes}
            voters={votersA}
          />
          <ContestantCard
            task={round.answerTasks[1]}
            voteCount={votesB}
            totalVotes={totalVotes}
            isWinner={isDone && votesB > votesA}
            showVotes={showVotes}
            voters={votersB}
          />
        </div>
      )}

      {isDone && votesA === votesB && totalVotes > 0 && (
        <div className="tie-label">Tie</div>
      )}
    </div>
  );
}

// ── Game Over ────────────────────────────────────────────────────────────────

function GameOver({
  scores,
}: {
  scores: Record<string, number>;
}) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const champion = sorted[0];

  return (
    <div className="game-over">
      <div className="game-over__label">Game Over</div>
      {champion && champion[1] > 0 && (
        <div className="game-over__winner">
          <span className="game-over__crown">👑</span>
          <span
            className="game-over__name"
            style={{ color: getColor(champion[0]) }}
          >
            {getLogo(champion[0]) && <img src={getLogo(champion[0])!} alt="" />}
            {champion[0]}
          </span>
          <span className="game-over__sub">is the funniest AI</span>
        </div>
      )}
    </div>
  );
}

// ── Standings ────────────────────────────────────────────────────────────────

function Standings({
  scores,
  streaks,
  activeRound,
}: {
  scores: Record<string, number>;
  streaks: StreakMap;
  activeRound: RoundState | null;
}) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const maxScore = sorted[0]?.[1] || 1;

  const competing = activeRound
    ? new Set([
        activeRound.contestants[0].name,
        activeRound.contestants[1].name,
      ])
    : new Set<string>();

  return (
    <aside className="standings">
      <div className="standings__head">
        <span className="standings__title">Standings</span>
        <div className="standings__links">
          <a href="/history" className="standings__link">
            History
          </a>
          <a href="https://twitch.tv/quipslop" target="_blank" rel="noopener noreferrer" className="standings__link">
            Twitch
          </a>
          <a href="https://github.com/T3-Content/quipslop" target="_blank" rel="noopener noreferrer" className="standings__link">
            GitHub
          </a>
        </div>
      </div>
      <div className="standings__list">
        {sorted.map(([name, score], i) => {
          const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
          const color = getColor(name);
          const active = competing.has(name);
          const streak = streaks[name] ?? { current: 0 };
          return (
            <div
              key={name}
              className={`standing ${active ? "standing--active" : ""}`}
            >
              <span className="standing__rank">
                {i === 0 && score > 0 ? "👑" : i + 1}
              </span>
              <ModelTag model={{ id: name, name }} small />
              {streak.current >= 2 && (
                <span className="standing__heat" title={`Win streak ${streak.current}`}>
                  🔥 {streak.current}
                </span>
              )}
              <div className="standing__bar">
                <div
                  className="standing__fill"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
              <span className="standing__score">{score}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── Connecting ───────────────────────────────────────────────────────────────

function ConnectingScreen() {
  return (
    <div className="connecting">
      <div className="connecting__logo">
        <img src="/assets/logo.svg" alt="quipslop" />
      </div>
      <div className="connecting__sub">
        Connecting
        <Dots />
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<GameState | null>(null);
  const [totalRounds, setTotalRounds] = useState<number | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    let knownVersion: string | null = null;
    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);
        if (msg.type === "state") {
          if (msg.version) {
            if (!knownVersion) knownVersion = msg.version;
            else if (knownVersion !== msg.version) return location.reload();
          }
          setState(msg.data);
          setTotalRounds(msg.totalRounds);
          setViewerCount(msg.viewerCount);
        } else if (msg.type === "viewerCount") {
          setViewerCount(msg.viewerCount);
        }
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  if (!connected || !state) return <ConnectingScreen />;

  const isNextPrompting =
    state.active?.phase === "prompting" && !state.active.prompt;
  const displayRound =
    isNextPrompting && state.lastCompleted ? state.lastCompleted : state.active;

  return (
    <div className="app">
      <div className="layout">
        <main className="main">
          <header className="header">
            <a href="/" className="logo">
              <img src="/assets/logo.svg" alt="quipslop" />
            </a>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {state.isPaused && (
                <div
                  className="viewer-pill"
                  style={{ color: "var(--text-muted)", borderColor: "var(--border)" }}
                >
                  Paused
                </div>
              )}
              <div className="viewer-pill" aria-live="polite">
                <span className="viewer-pill__dot" />
                {viewerCount} viewer{viewerCount === 1 ? "" : "s"} watching
              </div>
            </div>
          </header>

          {state.done ? (
            <GameOver scores={state.scores} />
          ) : displayRound ? (
            <Arena round={displayRound} total={totalRounds} />
          ) : (
            <div className="waiting">
              Starting
              <Dots />
            </div>
          )}

          {isNextPrompting && state.lastCompleted && (
            <div className="next-toast">
              <ModelTag model={state.active!.prompter} small /> is writing the
              next prompt
              <Dots />
            </div>
          )}
        </main>

        <Standings
          scores={state.scores}
          streaks={state.streaks}
          activeRound={state.active}
        />
      </div>
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
