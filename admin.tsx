import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

type BenchSummary = {
  id: string;
  status: string;
  totalRounds: number;
  completedRounds: number;
} | null;

type AdminSnapshot = {
  isPaused: boolean;
  isRunningRound: boolean;
  done: boolean;
  completedInMemory: number;
  persistedRounds: number;
  viewerCount: number;
  bench?: BenchSummary;
};

type AdminResponse = { ok: true } & AdminSnapshot;
type Mode = "checking" | "locked" | "ready";

const RESET_TOKEN = "RESET";

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (text) return text;
  return `Request failed (${res.status})`;
}

async function requestAdminJson(
  path: string,
  init?: RequestInit,
): Promise<AdminResponse> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as AdminResponse;
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-card">
      <div className="status-card__label">{label}</div>
      <div className="status-card__value">{value}</div>
    </div>
  );
}

function App() {
  const [mode, setMode] = useState<Mode>("checking");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [benchRoundsPerPairing, setBenchRoundsPerPairing] = useState(1);

  useEffect(() => {
    let mounted = true;

    requestAdminJson("/api/admin/status")
      .then((data) => {
        if (!mounted) return;
        setSnapshot(data);
        setMode("ready");
      })
      .catch(() => {
        if (!mounted) return;
        setSnapshot(null);
        setMode("locked");
      });

    return () => {
      mounted = false;
    };
  }, []);

  const busy = useMemo(() => pending !== null, [pending]);

  async function onLogin(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("login");
    try {
      const data = await requestAdminJson("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ passcode }),
      });
      setSnapshot(data);
      setPasscode("");
      setMode("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log in");
    } finally {
      setPending(null);
    }
  }

  async function runControl(path: string, task: string) {
    setError(null);
    setPending(task);
    try {
      const data = await requestAdminJson(path, { method: "POST" });
      setSnapshot(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Admin action failed";
      if (message.toLowerCase().includes("unauthorized")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onExport() {
    setError(null);
    setPending("export");
    try {
      const response = await fetch("/api/admin/export", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      const fileName = fileNameMatch?.[1] ?? `quipslop-export-${Date.now()}.json`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";
      if (message.toLowerCase().includes("unauthorized")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onReset() {
    setError(null);
    setPending("reset");
    try {
      const data = await requestAdminJson("/api/admin/reset", {
        method: "POST",
        body: JSON.stringify({ confirm: RESET_TOKEN }),
      });
      setSnapshot(data);
      setResetText("");
      setIsResetOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setPending(null);
    }
  }

  async function onBenchStart() {
    setError(null);
    setPending("bench-start");
    try {
      const response = await fetch("/api/bench/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundsPerPairing: benchRoundsPerPairing }),
        cache: "no-store",
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Request failed (${response.status})`);
      }
      try {
        const statusData = await requestAdminJson("/api/admin/status");
        setSnapshot(statusData);
      } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start benchmark");
    } finally {
      setPending(null);
    }
  }

  async function onBenchCancel() {
    setError(null);
    setPending("bench-cancel");
    try {
      const response = await fetch("/api/bench/cancel", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      try {
        const statusData = await requestAdminJson("/api/admin/status");
        setSnapshot(statusData);
      } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel benchmark");
    } finally {
      setPending(null);
    }
  }

  async function onLogout() {
    setError(null);
    setPending("logout");
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        cache: "no-store",
      });
      setSnapshot(null);
      setPasscode("");
      setMode("locked");
    } finally {
      setPending(null);
    }
  }

  if (mode === "checking") {
    return (
      <div className="admin admin--centered">
        <div className="loading">Checking admin session...</div>
      </div>
    );
  }

  if (mode === "locked") {
    return (
      <div className="admin admin--centered">
        <main className="panel panel--login">
          <a href="/" className="logo-link">
            <img src="/assets/logo.svg" alt="quipslop" />
          </a>
          <h1>Admin Access</h1>
          <p className="muted">
            Enter your passcode once. A secure cookie will keep this browser
            logged in.
          </p>

          <form
            onSubmit={onLogin}
            className="login-form"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          >
            <label htmlFor="passcode" className="field-label">
              Passcode
            </label>
            <input
              id="passcode"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              className="text-input"
              autoFocus
              autoComplete="off"
              required
              data-1p-ignore
              data-lpignore="true"
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !passcode.trim()}
              data-1p-ignore
              data-lpignore="true"
            >
              {pending === "login" ? "Checking..." : "Unlock Admin"}
            </button>
          </form>

          {error && <div className="error-banner">{error}</div>}

          <div className="quick-links">
            <a href="/">Live Game</a>
            <a href="/history">History</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="admin-header">
        <a href="/" className="logo-link">
          quipslop
        </a>
        <nav className="quick-links">
          <a href="/">Live Game</a>
          <a href="/history">History</a>
          <a href="/bench">Bench</a>
          <button className="link-button" onClick={onLogout} disabled={busy}>
            Logout
          </button>
        </nav>
      </header>

      <main className="panel panel--main">
        <div className="panel-head">
          <h1>Admin Console</h1>
          <p>
            Pause/resume the game loop, export all data as JSON, or wipe all
            stored data.
          </p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <section className="status-grid" aria-live="polite">
          <StatusCard
            label="Engine"
            value={snapshot?.isPaused ? "Paused" : "Running"}
          />
          <StatusCard
            label="Active Round"
            value={snapshot?.isRunningRound ? "In Progress" : "Idle"}
          />
          <StatusCard
            label="Persisted Rounds"
            value={String(snapshot?.persistedRounds ?? 0)}
          />
          <StatusCard label="Viewers" value={String(snapshot?.viewerCount ?? 0)} />
        </section>

        <section className="actions" aria-label="Admin actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || Boolean(snapshot?.isPaused)}
            onClick={() => runControl("/api/admin/pause", "pause")}
          >
            {pending === "pause" ? "Pausing..." : "Pause"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !snapshot?.isPaused}
            onClick={() => runControl("/api/admin/resume", "resume")}
          >
            {pending === "resume" ? "Resuming..." : "Resume"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onExport}>
            {pending === "export" ? "Exporting..." : "Export JSON"}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => setIsResetOpen(true)}
          >
            Reset Data
          </button>
        </section>
      </main>

      <section className="panel panel--main" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "clamp(24px, 4vw, 36px)", lineHeight: 1 }}>
            Benchmark
          </h2>
          <p>
            Run a round-robin benchmark where every model plays against every
            other model.{" "}
            <a href="/bench" style={{ color: "var(--accent)", textDecoration: "none" }}>
              View results
            </a>
          </p>
        </div>

        {snapshot?.bench ? (
          <div>
            <div className="status-grid" style={{ marginBottom: 16 }}>
              <StatusCard label="Status" value={snapshot.bench.status} />
              <StatusCard
                label="Progress"
                value={`${snapshot.bench.completedRounds}/${snapshot.bench.totalRounds}`}
              />
            </div>
            <div className="actions" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={onBenchCancel}
              >
                {pending === "bench-cancel" ? "Cancelling..." : "Cancel Benchmark"}
              </button>
              <a
                href="/bench"
                className="btn"
                style={{ textAlign: "center", textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              >
                View Live Results
              </a>
            </div>
          </div>
        ) : (
          <div className="actions" style={{ gridTemplateColumns: "auto 1fr auto" }}>
            <select
              value={benchRoundsPerPairing}
              onChange={(e) => setBenchRoundsPerPairing(Number(e.target.value))}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                padding: "10px 12px",
                outline: "none",
              }}
              disabled={busy}
            >
              <option value={1}>1 round/pairing</option>
              <option value={3}>3 rounds/pairing</option>
              <option value={5}>5 rounds/pairing</option>
            </select>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={onBenchStart}
            >
              {pending === "bench-start" ? "Starting..." : "Start Benchmark"}
            </button>
            <a
              href="/bench"
              className="btn"
              style={{ textAlign: "center", textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              Past Results
            </a>
          </div>
        )}
      </section>

      {isResetOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Reset all data?</h2>
            <p>
              This permanently deletes every saved round and resets scores.
              Current game flow is also paused.
            </p>
            <p>
              Type <code>{RESET_TOKEN}</code> to continue.
            </p>
            <input
              type="text"
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              className="text-input"
              placeholder={RESET_TOKEN}
              autoFocus
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIsResetOpen(false);
                  setResetText("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={onReset}
                disabled={busy || resetText !== RESET_TOKEN}
              >
                {pending === "reset" ? "Resetting..." : "Confirm Reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
