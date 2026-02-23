import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

type AdminSnapshot = {
  isPaused: boolean;
  isRunningRound: boolean;
  done: boolean;
  completedInMemory: number;
  persistedRounds: number;
  viewerCount: number;
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

  // Poll admin status every 10 seconds when authenticated
  useEffect(() => {
    if (mode !== "ready") return;
    const interval = setInterval(() => {
      requestAdminJson("/api/admin/status")
        .then((data) => setSnapshot(data))
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(interval);
  }, [mode]);

  // Modal escape key handler
  useEffect(() => {
    if (!isResetOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsResetOpen(false);
        setResetText("");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isResetOpen]);

  // Modal focus trap
  const modalRef = useRef<HTMLDivElement>(null);
  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'button, input, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const busy = pending !== null;

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

      {isResetOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onKeyDown={handleModalKeyDown}>
          <div className="modal" ref={modalRef}>
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
