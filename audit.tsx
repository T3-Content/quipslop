import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./audit.css";
import {
  applyRoundToStreaks,
  createEmptyStreaks,
  getRoundWinnerIndex,
  streakMapsEqual,
  type StreakMap,
} from "./streaks.ts";

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

type AuditResponse = {
  generatedAt: string;
  modelNames: string[];
  rounds: RoundState[];
  liveStreaks: StreakMap;
  derivedStreaks: StreakMap;
  hasMismatch: boolean;
};

type TimelineState = "idle" | "win" | "loss" | "tie";

type TimelineCell = {
  roundNum: number;
  state: TimelineState;
  streakAfterWin: number | null;
  title: string;
};

type RoundEvent = {
  roundNum: number;
  contestants: [string, string];
  winner: string | null;
  winnerStreak: number | null;
  scoreA?: number;
  scoreB?: number;
  prompt?: string;
};

type TimelineData = {
  sortedRounds: RoundState[];
  cellsByModel: Record<string, TimelineCell[]>;
  events: RoundEvent[];
};

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
  return MODEL_COLORS[name] ?? "#B6C1D5";
}

function buildCellTitle(round: RoundState): string {
  const scoreText =
    round.scoreA !== undefined && round.scoreB !== undefined
      ? `${round.scoreA / 100}-${round.scoreB / 100}`
      : "n/a";
  return `R${round.num}\n${round.contestants[0].name} vs ${round.contestants[1].name}\nScore ${scoreText}\n${round.prompt ?? "No prompt"}`;
}

function buildTimeline(modelNames: string[], rounds: RoundState[]): TimelineData {
  const sortedRounds = [...rounds].sort((a, b) => a.num - b.num);
  const cellsByModel = Object.fromEntries(
    modelNames.map((name) => [name, [] as TimelineCell[]]),
  );
  const events: RoundEvent[] = [];
  const runningStreaks = createEmptyStreaks(modelNames);

  for (const round of sortedRounds) {
    const title = buildCellTitle(round);
    const [a, b] = round.contestants.map((model) => model.name) as [
      string,
      string,
    ];
    const winnerIndex = getRoundWinnerIndex(round);
    const winner = winnerIndex === null ? null : round.contestants[winnerIndex].name;
    const isTie =
      round.scoreA !== undefined &&
      round.scoreB !== undefined &&
      round.scoreA === round.scoreB;

    for (const name of modelNames) {
      let state: TimelineState = "idle";
      if (name === a || name === b) {
        if (isTie) state = "tie";
        else if (winner === name) state = "win";
        else if (winner !== null) state = "loss";
      }

      const rowCells = cellsByModel[name];
      if (!rowCells) {
        continue;
      }

      rowCells.push({
        roundNum: round.num,
        state,
        streakAfterWin: null,
        title,
      });
    }

    applyRoundToStreaks(runningStreaks, round);

    if (winner !== null) {
      const winnerCell = cellsByModel[winner]?.at(-1);
      if (winnerCell) {
        winnerCell.streakAfterWin = runningStreaks[winner]?.current ?? 0;
      }
    }

    events.push({
      roundNum: round.num,
      contestants: [a, b],
      winner,
      winnerStreak: winner ? (runningStreaks[winner]?.current ?? null) : null,
      scoreA: round.scoreA,
      scoreB: round.scoreB,
      prompt: round.prompt,
    });
  }

  return { sortedRounds, cellsByModel, events };
}

function App() {
  const [payload, setPayload] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const response = await fetch("/api/audit", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data = (await response.json()) as AuditResponse;
        if (!alive) return;
        setPayload(data);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load audit data");
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    const id = window.setInterval(load, 5_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const modelNames = payload?.modelNames ?? [];
  const liveStreaks = payload?.liveStreaks ?? createEmptyStreaks(modelNames);
  const derivedStreaks = payload?.derivedStreaks ?? createEmptyStreaks(modelNames);

  const timeline = useMemo(
    () => buildTimeline(modelNames, payload?.rounds ?? []),
    [modelNames, payload?.rounds],
  );

  const streakRows = useMemo(() => {
    const entries = modelNames.map((name) => {
      const live = liveStreaks[name] ?? { current: 0, best: 0 };
      const derived = derivedStreaks[name] ?? { current: 0, best: 0 };
      return {
        name,
        live,
        derived,
      };
    });

    return entries.sort(
      (a, b) =>
        b.live.current - a.live.current ||
        b.live.best - a.live.best ||
        a.name.localeCompare(b.name),
    );
  }, [derivedStreaks, liveStreaks, modelNames]);

  const hasMismatch = payload?.hasMismatch || !streakMapsEqual(liveStreaks, derivedStreaks);

  if (loading) {
    return (
      <div className="audit audit--centered">
        <div className="loading">Loading streak audit...</div>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="audit audit--centered">
        <div className="error">{error ?? "Audit payload missing"}</div>
      </div>
    );
  }

  return (
    <div className="audit">
      <header className="audit-header">
        <div>
          <a href="/" className="logo-link">
            quipslop
          </a>
          <p className="subtitle">Win-streak verification dashboard</p>
        </div>
        <nav className="nav-links">
          <a href="/">Live</a>
          <a href="/history">History</a>
          <a href="https://github.com/T3-Content/quipslop" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <section className="meta-row">
        <div className="pill">Rounds tracked: {timeline.sortedRounds.length}</div>
        <div className="pill">Refreshed: {new Date(payload.generatedAt).toLocaleTimeString()}</div>
        <div className={`pill ${hasMismatch ? "pill--warn" : "pill--ok"}`}>
          {hasMismatch ? "Mismatch detected" : "Live and derived streaks match"}
        </div>
      </section>

      <section className="streak-grid" aria-label="Current and best streaks">
        {streakRows.map((row) => {
          const drift =
            row.live.current !== row.derived.current || row.live.best !== row.derived.best;
          return (
            <article key={row.name} className={`streak-card ${drift ? "streak-card--drift" : ""}`}>
              <div className="streak-card__name" style={{ color: getColor(row.name) }}>
                {row.name}
              </div>
              <div className="streak-card__stats">
                <span>
                  live <strong>x{row.live.current}</strong>
                </span>
                <span>
                  best <strong>x{row.live.best}</strong>
                </span>
              </div>
              <div className="streak-card__derived">
                derived x{row.derived.current} / best x{row.derived.best}
              </div>
            </article>
          );
        })}
      </section>

      <section className="legend">
        <span className="legend__item"><i className="dot dot--win" />Win</span>
        <span className="legend__item"><i className="dot dot--loss" />Loss</span>
        <span className="legend__item"><i className="dot dot--tie" />Tie</span>
        <span className="legend__item"><i className="dot dot--idle" />Not in round</span>
        <span className="legend__item">Winning cells show streak count after that round</span>
      </section>

      <section className="timeline-shell" aria-label="Streak timeline matrix">
        <div className="timeline-scroll">
          <table className="timeline">
            <thead>
              <tr>
                <th className="timeline__model">Model</th>
                {timeline.sortedRounds.map((round) => (
                  <th key={round.num} className="timeline__round">R{round.num}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modelNames.map((name) => (
                <tr key={name}>
                  <th className="timeline__model timeline__model--row" style={{ color: getColor(name) }}>
                    {name}
                  </th>
                  {timeline.cellsByModel[name]?.map((cell) => (
                    <td
                      key={`${name}-${cell.roundNum}`}
                      className={`timeline__cell timeline__cell--${cell.state}`}
                      title={cell.title}
                    >
                      {cell.state === "win" ? cell.streakAfterWin : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="events" aria-label="Recent rounds">
        <h2>Recent rounds</h2>
        <div className="events__list">
          {[...timeline.events].reverse().slice(0, 12).map((event) => (
            <article key={event.roundNum} className="event-card">
              <div className="event-card__head">
                <span>R{event.roundNum}</span>
                <span>
                  {event.scoreA !== undefined && event.scoreB !== undefined
                    ? `${event.scoreA / 100}-${event.scoreB / 100}`
                    : "n/a"}
                </span>
              </div>
              <div className="event-card__matchup">
                {event.contestants[0]} vs {event.contestants[1]}
              </div>
              <div className="event-card__winner">
                {event.winner
                  ? `${event.winner} won (streak x${event.winnerStreak ?? 0})`
                  : "Tie / no winner"}
              </div>
              <p className="event-card__prompt">{event.prompt ?? "No prompt"}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
