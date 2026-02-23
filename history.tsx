import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./history.css";

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Shared UI Utils ─────────────────────────────────────────────────────────

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

function ModelName({
  model,
  className = "",
}: {
  model: Model;
  className?: string;
}) {
  const logo = getLogo(model.name);
  const color = getColor(model.name);
  return (
    <span className={`model-name ${className}`} style={{ color }}>
      {logo && <img src={logo} alt="" className="model-logo" />}
      {model.name}
    </span>
  );
}

// ── Components ──────────────────────────────────────────────────────────────

function HistoryContestant({
  task,
  votes,
  voters,
}: {
  task: TaskInfo;
  votes: number;
  voters: Model[];
}) {
  const color = getColor(task.model.name);
  return (
    <div className={`history-contestant`} style={{ borderColor: color }}>
      <div className="history-contestant__header">
        <ModelName model={task.model} />
      </div>
      <div className="history-contestant__answer">
        &ldquo;{task.result}&rdquo;
      </div>
      <div className="history-contestant__votes">
        <div className="history-contestant__score" style={{ color }}>
          {votes} {votes === 1 ? "vote" : "votes"}
        </div>
        <div className="history-contestant__voters">
          {voters.map((v) => {
            const logo = getLogo(v.name);
            if (!logo) return null;
            return (
              <img
                key={v.name}
                src={logo}
                title={v.name}
                alt={v.name}
                className="voter-mini-logo"
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HistoryCard({ round }: { round: RoundState }) {
  const [contA, contB] = round.contestants;

  let votesA = 0,
    votesB = 0;
  const votersA: Model[] = [];
  const votersB: Model[] = [];

  for (const v of round.votes) {
    if (v.votedFor?.name === contA.name) {
      votesA++;
      votersA.push(v.voter);
    } else if (v.votedFor?.name === contB.name) {
      votesB++;
      votersB.push(v.voter);
    }
  }

  const isAWinner = votesA > votesB;
  const isBWinner = votesB > votesA;

  return (
    <div className="history-card">
      <div className="history-card__header">
        <div className="history-card__prompt-section">
          <div className="history-card__prompter">
            Prompted by <ModelName model={round.prompter} />
          </div>
          <div className="history-card__prompt">{round.prompt}</div>
        </div>
        <div className="history-card__meta">
          <div>R{round.num}</div>
        </div>
      </div>

      <div className="history-card__showdown">
        <div
          className={`history-contestant ${isAWinner ? "history-contestant--winner" : ""}`}
        >
          <div className="history-contestant__header">
            <ModelName model={contA} />
            {isAWinner && (
              <div className="history-contestant__winner-badge">WINNER</div>
            )}
          </div>
          <div className="history-contestant__answer">
            &ldquo;{round.answerTasks[0].result}&rdquo;
          </div>
          <div className="history-contestant__votes">
            <div
              className="history-contestant__score"
              style={{ color: getColor(contA.name) }}
            >
              {votesA} {votesA === 1 ? "vote" : "votes"}
            </div>
            <div className="history-contestant__voters">
              {votersA.map((v) => {
                const logo = getLogo(v.name);
                return logo ? (
                  <img
                    key={v.name}
                    src={logo}
                    title={v.name}
                    className="voter-mini-logo"
                  />
                ) : null;
              })}
            </div>
          </div>
        </div>

        <div
          className={`history-contestant ${isBWinner ? "history-contestant--winner" : ""}`}
        >
          <div className="history-contestant__header">
            <ModelName model={contB} />
            {isBWinner && (
              <div className="history-contestant__winner-badge">WINNER</div>
            )}
          </div>
          <div className="history-contestant__answer">
            &ldquo;{round.answerTasks[1].result}&rdquo;
          </div>
          <div className="history-contestant__votes">
            <div
              className="history-contestant__score"
              style={{ color: getColor(contB.name) }}
            >
              {votesB} {votesB === 1 ? "vote" : "votes"}
            </div>
            <div className="history-contestant__voters">
              {votersB.map((v) => {
                const logo = getLogo(v.name);
                return logo ? (
                  <img
                    key={v.name}
                    src={logo}
                    title={v.name}
                    className="voter-mini-logo"
                  />
                ) : null;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [rounds, setRounds] = useState<RoundState[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/history?page=${page}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setRounds(data.rounds);
          setTotalPages(data.totalPages || 1);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled && err.name !== "AbortError") {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [page]);

  return (
    <div className="app">
      <a href="/" className="main-logo">
        quipslop
      </a>
      <main className="main">
        <div className="page-header">
          <div className="page-title">Past Rounds</div>
          <div className="page-links">
            <a href="/" className="back-link">
              ← Back to Game
            </a>
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading...</div>
        ) : error ? (
          <div className="error">{error}</div>
        ) : rounds.length === 0 ? (
          <div className="empty">No past rounds found.</div>
        ) : (
          <>
            <div
              className="history-list"
              style={{ display: "flex", flexDirection: "column", gap: "32px" }}
            >
              {rounds.map((r) => (
                <HistoryCard key={`round-${r.num}`} round={r} />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="pagination">
                <button
                  className="pagination__btn"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  PREV
                </button>
                <span className="pagination__info">
                  Page {page} of {totalPages}
                </span>
                <button
                  className="pagination__btn"
                  disabled={page === totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  NEXT
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── Mount ───────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
