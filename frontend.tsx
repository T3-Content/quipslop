import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./frontend.css";

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
  completed: RoundState[];
  active: RoundState | null;
  scores: Record<string, number>;
  done: boolean;
  isPaused: boolean;
  generation: number;
};
type BetState = {
  roundNum: number;
  open: boolean;
  totals: Record<string, { count: number; total: number }>;
};
type ServerMessage = {
  type: "state";
  data: GameState;
  totalRounds: number;
  viewerCount: number;
  version?: string;
  betState: BetState | null;
};

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

// ── Nickname Modal ──────────────────────────────────────────────────────────

function NicknameModal({ onJoin }: { onJoin: (id: string, nickname: string) => void }) {
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nickname.trim();
    if (!trimmed || trimmed.length > 20) {
      setError("1-20 characters");
      return;
    }
    setLoading(true);
    setError("");
    const id = crypto.randomUUID();
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, nickname: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed");
        setLoading(false);
        return;
      }
      localStorage.setItem("qs_userId", data.user.id);
      localStorage.setItem("qs_nickname", data.user.nickname);
      localStorage.setItem("qs_balance", String(data.user.balance));
      onJoin(data.user.id, data.user.nickname);
    } catch {
      setError("Network error");
      setLoading(false);
    }
  };

  return (
    <div className="nickname-modal">
      <form className="nickname-modal__card" onSubmit={handleSubmit}>
        <div className="nickname-modal__title">Join the Betting Pool</div>
        <div className="nickname-modal__sub">Pick a nickname to start betting with 1,000 coins</div>
        <input
          className="nickname-modal__input"
          type="text"
          placeholder="Your nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={20}
          autoFocus
        />
        {error && <div className="nickname-modal__error">{error}</div>}
        <button className="nickname-modal__btn" type="submit" disabled={loading}>
          {loading ? "Joining..." : "Join"}
        </button>
      </form>
    </div>
  );
}

// ── Betting Panel ────────────────────────────────────────────────────────────

function BettingPanel({
  round,
  betState,
  userId,
  balance,
  onBalanceChange,
}: {
  round: RoundState;
  betState: BetState | null;
  userId: string;
  balance: number;
  onBalanceChange: (b: number) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [amount, setAmount] = useState(50);
  const [myBet, setMyBet] = useState<{ contestant: string; amount: number } | null>(null);
  const [error, setError] = useState("");
  const [placing, setPlacing] = useState(false);
  const lastRoundRef = React.useRef<number>(0);

  // Reset when round changes
  useEffect(() => {
    if (round.num !== lastRoundRef.current) {
      lastRoundRef.current = round.num;
      setMyBet(null);
      setSelected(null);
      setError("");
      // Check if we already bet this round
      if (userId) {
        fetch(`/api/me?id=${encodeURIComponent(userId)}`)
          .then(r => r.json())
          .then(data => {
            if (data.currentBet) {
              setMyBet({ contestant: data.currentBet.contestant, amount: data.currentBet.amount });
            }
            if (data.user) {
              onBalanceChange(data.user.balance);
            }
          })
          .catch(() => {});
      }
    }
  }, [round.num, userId, onBalanceChange]);

  const isOpen = betState?.open && round.num === betState.roundNum;
  const [contA, contB] = round.contestants;

  if (myBet) {
    return (
      <div className="betting-panel betting-panel--placed">
        <div className="betting-panel__placed">
          Your bet: <strong>{myBet.amount}</strong> coins on{" "}
          <ModelTag model={{ id: myBet.contestant, name: myBet.contestant }} small />
        </div>
        {betState && (
          <div className="betting-panel__pools">
            {[contA, contB].map(c => {
              const t = betState.totals[c.name];
              return (
                <div key={c.name} className="betting-panel__pool">
                  <ModelTag model={c} small />
                  <span className="betting-panel__pool-stat">
                    {t ? `${t.count} bet${t.count !== 1 ? "s" : ""} · ${t.total} coins` : "No bets"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (!isOpen) return null;

  const handlePlace = async () => {
    if (!selected || amount <= 0) return;
    const placedForRound = round.num;
    setPlacing(true);
    setError("");
    try {
      const res = await fetch("/api/bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, roundNum: placedForRound, contestant: selected, amount }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed");
        setPlacing(false);
        return;
      }
      // Only update if we're still on the same round
      if (lastRoundRef.current === placedForRound) {
        setMyBet({ contestant: selected, amount });
        onBalanceChange(data.balance);
        localStorage.setItem("qs_balance", String(data.balance));
      }
    } catch {
      setError("Network error");
    }
    setPlacing(false);
  };

  return (
    <div className="betting-panel">
      <div className="betting-panel__title">Place Your Bet</div>
      <div className="betting-panel__options">
        {[contA, contB].map(c => (
          <button
            key={c.name}
            className={`bet-option ${selected === c.name ? "bet-option--selected" : ""}`}
            style={{ "--accent": getColor(c.name) } as React.CSSProperties}
            onClick={() => setSelected(c.name)}
          >
            <ModelTag model={c} small />
            {betState?.totals[c.name] && (() => {
              const t = betState.totals[c.name]!;
              return (
                <span className="bet-option__pool">
                  {t.count} bet{t.count !== 1 ? "s" : ""}
                </span>
              );
            })()}
          </button>
        ))}
      </div>
      <div className="bet-input">
        <div className="bet-input__presets">
          {[10, 50, 100].map(v => (
            <button
              key={v}
              className={`bet-input__preset ${amount === v ? "bet-input__preset--active" : ""}`}
              onClick={() => setAmount(v)}
            >
              {v}
            </button>
          ))}
          <button
            className={`bet-input__preset ${amount === balance ? "bet-input__preset--active" : ""}`}
            onClick={() => setAmount(balance)}
          >
            ALL IN
          </button>
        </div>
        <input
          className="bet-input__field"
          type="number"
          min={1}
          max={balance}
          value={amount}
          onChange={e => setAmount(Math.max(1, Math.min(balance, parseInt(e.target.value) || 0)))}
        />
      </div>
      {error && <div className="betting-panel__error">{error}</div>}
      <button
        className="betting-panel__confirm"
        disabled={!selected || amount <= 0 || amount > balance || placing}
        onClick={handlePlace}
      >
        {placing ? "Placing..." : `Bet ${amount} coins`}
      </button>
    </div>
  );
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

function LeaderboardPanel() {
  const [board, setBoard] = useState<{ id: string; nickname: string; balance: number }[]>([]);

  useEffect(() => {
    const load = () => {
      fetch("/api/leaderboard")
        .then(r => r.json())
        .then(data => { if (Array.isArray(data)) setBoard(data); })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, []);

  if (board.length === 0) return null;

  return (
    <div className="leaderboard">
      <div className="leaderboard__title">Top Bettors</div>
      <div className="leaderboard__list">
        {board.map((u, i) => (
          <div key={u.id} className="leaderboard__row">
            <span className="leaderboard__rank">{i + 1}</span>
            <span className="leaderboard__name">{u.nickname}</span>
            <span className="leaderboard__bal">{u.balance}</span>
          </div>
        ))}
      </div>
    </div>
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

function GameOver({ scores }: { scores: Record<string, number> }) {
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
  activeRound,
}: {
  scores: Record<string, number>;
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
          return (
            <div
              key={name}
              className={`standing ${active ? "standing--active" : ""}`}
            >
              <span className="standing__rank">
                {i === 0 && score > 0 ? "👑" : i + 1}
              </span>
              <ModelTag model={{ id: name, name }} small />
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
  const [betState, setBetState] = useState<BetState | null>(null);

  // User identity
  const [userId, setUserId] = useState(() => localStorage.getItem("qs_userId") || "");
  const [nickname, setNickname] = useState(() => localStorage.getItem("qs_nickname") || "");
  const [balance, setBalance] = useState(() => parseInt(localStorage.getItem("qs_balance") || "0", 10));
  const [showNicknameModal, setShowNicknameModal] = useState(false);

  // Sync user on first load
  useEffect(() => {
    if (userId) {
      fetch(`/api/me?id=${encodeURIComponent(userId)}`)
        .then(r => {
          if (!r.ok) {
            // User was deleted (e.g. admin reset)
            localStorage.removeItem("qs_userId");
            localStorage.removeItem("qs_nickname");
            localStorage.removeItem("qs_balance");
            setUserId("");
            setNickname("");
            setBalance(0);
            return null;
          }
          return r.json();
        })
        .then(data => {
          if (data?.user) {
            setBalance(data.user.balance);
            localStorage.setItem("qs_balance", String(data.user.balance));
          }
        })
        .catch(() => {});
    }
  }, [userId]);

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
          setBetState(msg.betState);
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

  const lastCompleted = state.completed[state.completed.length - 1];
  const isNextPrompting =
    state.active?.phase === "prompting" && !state.active.prompt;
  const displayRound =
    isNextPrompting && lastCompleted ? lastCompleted : state.active;

  const handleJoin = (id: string, nick: string) => {
    setUserId(id);
    setNickname(nick);
    setBalance(1000);
    setShowNicknameModal(false);
  };

  const bettingRound = state.active;

  return (
    <div className="app">
      {showNicknameModal && <NicknameModal onJoin={handleJoin} />}
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
              {userId ? (
                <div className="user-balance" title={nickname}>
                  <span className="user-balance__coins">{balance}</span>
                  <span className="user-balance__label">coins</span>
                </div>
              ) : (
                <button className="join-btn" onClick={() => setShowNicknameModal(true)}>
                  Bet
                </button>
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
            <>
              <Arena round={displayRound} total={totalRounds} />
              {userId && bettingRound && (
                <BettingPanel
                  round={bettingRound}
                  betState={betState}
                  userId={userId}
                  balance={balance}
                  onBalanceChange={(b) => {
                    setBalance(b);
                    localStorage.setItem("qs_balance", String(b));
                  }}
                />
              )}
            </>
          ) : (
            <div className="waiting">
              Starting
              <Dots />
            </div>
          )}

          {isNextPrompting && lastCompleted && (
            <div className="next-toast">
              <ModelTag model={state.active!.prompter} small /> is writing the
              next prompt
              <Dots />
            </div>
          )}
        </main>

        <div className="sidebar">
          <Standings scores={state.scores} activeRound={state.active} />
          <LeaderboardPanel />
        </div>
      </div>
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
