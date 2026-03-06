import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "./bench.css";

// ── Types ────────────────────────────────────────────────────────────────────

type Model = { id: string; name: string };

type BenchRun = {
  id: string;
  status: string;
  config: string;
  started_at: number;
  finished_at: number | null;
  total_rounds: number;
  completed_rounds: number;
  error: string | null;
};

type BenchRoundData = {
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

type BenchRound = {
  id: number;
  run_id: string;
  pairing_index: number;
  round_num: number;
  data: string;
};

type ActiveBenchState = {
  id: string;
  status: string;
  totalRounds: number;
  completedRounds: number;
  currentPairing?: { modelA: Model; modelB: Model };
  currentRound?: number;
} | null;

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

// ── Rankings computation ─────────────────────────────────────────────────────

type ModelStats = {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  totalVotesFor: number;
  totalVotesCast: number;
};

function computeRankings(rounds: BenchRoundData[]): ModelStats[] {
  const stats: Record<string, ModelStats> = {};

  function ensure(name: string) {
    if (!stats[name]) {
      stats[name] = {
        name,
        wins: 0,
        losses: 0,
        ties: 0,
        totalVotesFor: 0,
        totalVotesCast: 0,
      };
    }
  }

  for (const r of rounds) {
    if (r.error) continue;
    ensure(r.modelA.name);
    ensure(r.modelB.name);

    const totalVotes = r.votesA + r.votesB;
    stats[r.modelA.name]!.totalVotesFor += r.votesA;
    stats[r.modelA.name]!.totalVotesCast += totalVotes;
    stats[r.modelB.name]!.totalVotesFor += r.votesB;
    stats[r.modelB.name]!.totalVotesCast += totalVotes;

    if (r.winner === "A") {
      stats[r.modelA.name]!.wins++;
      stats[r.modelB.name]!.losses++;
    } else if (r.winner === "B") {
      stats[r.modelB.name]!.wins++;
      stats[r.modelA.name]!.losses++;
    } else {
      stats[r.modelA.name]!.ties++;
      stats[r.modelB.name]!.ties++;
    }
  }

  return Object.values(stats).sort((a, b) => {
    const aWinPct =
      a.wins + a.losses + a.ties > 0
        ? a.wins / (a.wins + a.losses + a.ties)
        : 0;
    const bWinPct =
      b.wins + b.losses + b.ties > 0
        ? b.wins / (b.wins + b.losses + b.ties)
        : 0;
    if (bWinPct !== aWinPct) return bWinPct - aWinPct;
    return b.wins - a.wins;
  });
}

// ── Head-to-head computation ─────────────────────────────────────────────────

type H2HRecord = {
  wins: number;
  losses: number;
  ties: number;
  rounds: BenchRoundData[];
};

function computeH2H(
  rounds: BenchRoundData[],
): Record<string, Record<string, H2HRecord>> {
  const h2h: Record<string, Record<string, H2HRecord>> = {};

  function ensure(a: string, b: string) {
    if (!h2h[a]) h2h[a] = {};
    if (!h2h[a][b])
      h2h[a][b] = { wins: 0, losses: 0, ties: 0, rounds: [] };
  }

  for (const r of rounds) {
    if (r.error) continue;
    const a = r.modelA.name;
    const b = r.modelB.name;
    ensure(a, b);
    ensure(b, a);

    h2h[a]![b]!.rounds.push(r);
    h2h[b]![a]!.rounds.push(r);

    if (r.winner === "A") {
      h2h[a]![b]!.wins++;
      h2h[b]![a]!.losses++;
    } else if (r.winner === "B") {
      h2h[b]![a]!.wins++;
      h2h[a]![b]!.losses++;
    } else {
      h2h[a]![b]!.ties++;
      h2h[b]![a]!.ties++;
    }
  }

  return h2h;
}

// ── Components ───────────────────────────────────────────────────────────────

function BenchProgress({
  active,
  onCancel,
}: {
  active: ActiveBenchState;
  onCancel: () => void;
}) {
  if (!active || active.status !== "running") return null;

  const pct =
    active.totalRounds > 0
      ? Math.round((active.completedRounds / active.totalRounds) * 100)
      : 0;

  return (
    <div className="bench-progress">
      <div className="progress-info">
        <span className="progress-label">
          Benchmark running: <strong>{active.completedRounds}</strong> /{" "}
          {active.totalRounds} rounds
        </span>
        {active.currentPairing && (
          <span className="progress-current">
            <ModelTag model={active.currentPairing.modelA} small />
            {" vs "}
            <ModelTag model={active.currentPairing.modelB} small />
            {active.currentRound && ` (rep ${active.currentRound})`}
          </span>
        )}
      </div>
      <div className="progress-bar">
        <div className="progress-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-actions">
        <button className="btn btn--danger btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OverallRankings({ rounds }: { rounds: BenchRoundData[] }) {
  const rankings = useMemo(() => computeRankings(rounds), [rounds]);

  if (rankings.length === 0) return null;

  return (
    <div className="rankings">
      <h2>Overall Rankings</h2>
      <table className="rankings-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Model</th>
            <th className="num">W</th>
            <th className="num">L</th>
            <th className="num">T</th>
            <th className="num">Win%</th>
            <th className="num">Vote Share</th>
          </tr>
        </thead>
        <tbody>
          {rankings.map((s, i) => {
            const total = s.wins + s.losses + s.ties;
            const winPct = total > 0 ? ((s.wins / total) * 100).toFixed(1) : "0.0";
            const voteShare =
              s.totalVotesCast > 0
                ? ((s.totalVotesFor / s.totalVotesCast) * 100).toFixed(1)
                : "0.0";
            return (
              <tr key={s.name}>
                <td className="rank-num">
                  {i === 0 && s.wins > 0 ? (
                    <span className="rank-crown">👑</span>
                  ) : (
                    i + 1
                  )}
                </td>
                <td>
                  <ModelTag
                    model={{ id: s.name, name: s.name }}
                    small
                  />
                </td>
                <td className="num">{s.wins}</td>
                <td className="num">{s.losses}</td>
                <td className="num">{s.ties}</td>
                <td className="num win-pct" style={{ color: getColor(s.name) }}>
                  {winPct}%
                </td>
                <td className="num">{voteShare}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HeadToHeadMatrix({
  rounds,
  onSelectPairing,
}: {
  rounds: BenchRoundData[];
  onSelectPairing: (a: string, b: string) => void;
}) {
  const rankings = useMemo(() => computeRankings(rounds), [rounds]);
  const h2h = useMemo(() => computeH2H(rounds), [rounds]);
  const models = rankings.map((r) => r.name);

  if (models.length === 0) return null;

  return (
    <div className="matrix">
      <h2>Head-to-Head</h2>
      <div className="matrix-scroll">
        <table className="matrix-grid">
          <thead>
            <tr>
              <th className="row-header" />
              {models.map((m) => (
                <th key={m}>
                  <ModelTag model={{ id: m, name: m }} small />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={row}>
                <th className="row-header">
                  <ModelTag model={{ id: row, name: row }} small />
                </th>
                {models.map((col) => {
                  if (row === col) {
                    return (
                      <td key={col} className="matrix-self">
                        -
                      </td>
                    );
                  }
                  const record = h2h[row]?.[col];
                  if (!record) {
                    return (
                      <td key={col} className="matrix-tie">
                        -
                      </td>
                    );
                  }
                  const cls =
                    record.wins > record.losses
                      ? "matrix-win"
                      : record.losses > record.wins
                        ? "matrix-loss"
                        : "matrix-tie";
                  return (
                    <td
                      key={col}
                      className={cls}
                      onClick={() => onSelectPairing(row, col)}
                      title={`${row} vs ${col}: ${record.wins}W-${record.losses}L-${record.ties}T`}
                    >
                      {record.wins}-{record.losses}
                      {record.ties > 0 ? `-${record.ties}` : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatchupDetail({
  modelA,
  modelB,
  rounds,
  onClose,
}: {
  modelA: string;
  modelB: string;
  rounds: BenchRoundData[];
  onClose: () => void;
}) {
  const matchRounds = rounds.filter(
    (r) =>
      !r.error &&
      ((r.modelA.name === modelA && r.modelB.name === modelB) ||
        (r.modelA.name === modelB && r.modelB.name === modelA)),
  );

  return (
    <div className="matchup-detail">
      <div className="matchup-detail__header">
        <div className="matchup-detail__title">
          <ModelTag model={{ id: modelA, name: modelA }} small />
          {" vs "}
          <ModelTag model={{ id: modelB, name: modelB }} small />
        </div>
        <button className="matchup-detail__close" onClick={onClose}>
          Close
        </button>
      </div>
      {matchRounds.length === 0 ? (
        <div className="empty-state">No rounds played</div>
      ) : (
        matchRounds.map((r, i) => {
          const isAModelA = r.modelA.name === modelA;
          const leftModel = isAModelA ? r.modelA : r.modelB;
          const rightModel = isAModelA ? r.modelB : r.modelA;
          const leftAnswer = isAModelA ? r.answerA : r.answerB;
          const rightAnswer = isAModelA ? r.answerB : r.answerA;
          const leftVotes = isAModelA ? r.votesA : r.votesB;
          const rightVotes = isAModelA ? r.votesB : r.votesA;
          const leftWon = leftVotes > rightVotes;
          const rightWon = rightVotes > leftVotes;

          return (
            <div key={i} className="matchup-round">
              <div className="matchup-round__label">
                Round {i + 1} — prompted by{" "}
                <ModelTag model={r.prompter} small />
              </div>
              <div className="matchup-round__prompt">{r.prompt}</div>
              <div className="matchup-answers">
                <div
                  className={`matchup-answer ${leftWon ? "matchup-answer--winner" : ""}`}
                >
                  <div className="matchup-answer__model">
                    <ModelTag model={leftModel} small />
                    {leftWon && " WIN"}
                  </div>
                  <div className="matchup-answer__text">
                    &ldquo;{leftAnswer}&rdquo;
                  </div>
                  <div className="matchup-answer__votes">
                    {leftVotes} vote{leftVotes !== 1 ? "s" : ""}
                  </div>
                </div>
                <div
                  className={`matchup-answer ${rightWon ? "matchup-answer--winner" : ""}`}
                >
                  <div className="matchup-answer__model">
                    <ModelTag model={rightModel} small />
                    {rightWon && " WIN"}
                  </div>
                  <div className="matchup-answer__text">
                    &ldquo;{rightAnswer}&rdquo;
                  </div>
                  <div className="matchup-answer__votes">
                    {rightVotes} vote{rightVotes !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [roundsData, setRoundsData] = useState<BenchRoundData[]>([]);
  const [activeBench, setActiveBench] = useState<ActiveBenchState>(null);
  const [selectedPairing, setSelectedPairing] = useState<{
    a: string;
    b: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch runs list
  useEffect(() => {
    fetch("/api/bench/runs")
      .then((r) => r.json())
      .then((data: BenchRun[]) => {
        setRuns(data);
        if (data.length > 0 && !selectedRunId) {
          setSelectedRunId(data[0]!.id);
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load benchmark runs");
        setLoading(false);
      });
  }, []);

  // Fetch selected run results
  useEffect(() => {
    if (!selectedRunId) {
      setRoundsData([]);
      return;
    }
    fetch(`/api/bench/results/${selectedRunId}`)
      .then((r) => r.json())
      .then(
        (data: { run: BenchRun; rounds: BenchRound[] }) => {
          const parsed = data.rounds.map(
            (r) => JSON.parse(r.data) as BenchRoundData,
          );
          setRoundsData(parsed);
        },
      )
      .catch(() => setError("Failed to load run results"));
  }, [selectedRunId]);

  // WebSocket for real-time progress
  useEffect(() => {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    let unmounted = false;

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onclose = () => {
        if (!unmounted) reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.bench !== undefined) {
            setActiveBench(msg.bench);

            // Refresh runs list when bench status changes
            if (
              msg.bench === null ||
              msg.bench.status === "completed" ||
              msg.bench.status === "cancelled"
            ) {
              fetch("/api/bench/runs")
                .then((r) => r.json())
                .then((data: BenchRun[]) => {
                  setRuns(data);
                  if (data.length > 0) {
                    const latestId = data[0]!.id;
                    setSelectedRunId(latestId);
                    // Force re-fetch results even if selectedRunId didn't change
                    fetch(`/api/bench/results/${latestId}`)
                      .then((r) => r.json())
                      .then((resData: { run: BenchRun; rounds: BenchRound[] }) => {
                        setRoundsData(resData.rounds.map((r) => JSON.parse(r.data) as BenchRoundData));
                      })
                      .catch(() => {});
                  }
                })
                .catch(() => {});
            }
          }
        } catch {}
      };
    }

    connect();
    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  // Also fetch active status on mount
  useEffect(() => {
    fetch("/api/bench/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.active) setActiveBench(data.active);
      })
      .catch(() => {});
  }, []);

  async function handleCancel() {
    try {
      await fetch("/api/bench/cancel", { method: "POST" });
    } catch {
      setError("Failed to cancel benchmark");
    }
  }

  if (loading) {
    return (
      <div className="bench">
        <div className="loading">Loading benchmark data...</div>
      </div>
    );
  }

  return (
    <div className="bench">
      <header className="bench-header">
        <a href="/" className="logo-link">
          quipslop
        </a>
        <nav className="quick-links">
          <a href="/">Live Game</a>
          <a href="/history">History</a>
          <a href="/admin">Admin</a>
        </nav>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h1>Benchmark</h1>
          <p>
            Round-robin benchmark: every model plays against every other model.
            Results show overall rankings and head-to-head records.
          </p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <BenchProgress active={activeBench} onCancel={handleCancel} />

        {runs.length > 0 && (
          <div className="run-selector">
            <label>Run:</label>
            <select
              value={selectedRunId ?? ""}
              onChange={(e) => {
                setSelectedRunId(e.target.value);
                setSelectedPairing(null);
              }}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {new Date(run.started_at).toLocaleDateString()} —{" "}
                  {run.completed_rounds}/{run.total_rounds} rounds (
                  {run.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {roundsData.length > 0 ? (
        <>
          <OverallRankings rounds={roundsData} />

          {selectedPairing && (
            <MatchupDetail
              modelA={selectedPairing.a}
              modelB={selectedPairing.b}
              rounds={roundsData}
              onClose={() => setSelectedPairing(null)}
            />
          )}

          <HeadToHeadMatrix
            rounds={roundsData}
            onSelectPairing={(a, b) => setSelectedPairing({ a, b })}
          />
        </>
      ) : selectedRunId ? (
        <div className="empty-state">
          {activeBench?.id === selectedRunId
            ? "Benchmark in progress, results will appear as rounds complete..."
            : "No round data for this run"}
        </div>
      ) : (
        <div className="empty-state">
          No benchmark runs yet. Start one from the Admin panel.
        </div>
      )}

      {runs.length > 1 && (
        <div className="panel">
          <h2
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              fontWeight: 700,
              textTransform: "uppercase" as const,
              letterSpacing: 1,
              color: "var(--text-dim)",
              marginBottom: 16,
            }}
          >
            All Runs
          </h2>
          <div className="run-list">
            {runs.map((run) => (
              <div
                key={run.id}
                className={`run-item ${selectedRunId === run.id ? "run-item--active" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.id);
                  setSelectedPairing(null);
                }}
              >
                <span className={`run-item__status run-item__status--${run.status}`}>
                  {run.status}
                </span>
                <div className="run-item__info">
                  <span className="run-item__date">
                    {new Date(run.started_at).toLocaleString()}
                  </span>
                  <span className="run-item__stats">
                    {run.completed_rounds}/{run.total_rounds} rounds
                    {run.finished_at &&
                      ` — ${((run.finished_at - run.started_at) / 1000).toFixed(0)}s`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
