import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import indexHtml from "./index.html";
import historyHtml from "./history.html";
import adminHtml from "./admin.html";
import broadcastHtml from "./broadcast.html";
import { clearAllRounds, getRounds, getAllRounds } from "./db.ts";
import {
  MODELS,
  LOG_FILE,
  log,
  runGame,
  type GameState,
  type RoundState,
} from "./game.ts";

const VERSION = crypto.randomUUID().slice(0, 8);

// ── Game state ──────────────────────────────────────────────────────────────

const runsArg = process.argv.find((a) => a.startsWith("runs="));
const runsStr = runsArg ? runsArg.split("=")[1] : "infinite";
const runs =
  runsStr === "infinite" ? Infinity : parseInt(runsStr || "infinite", 10);

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: Set OPENROUTER_API_KEY environment variable");
  process.exit(1);
}

const allRounds = getAllRounds();
const initialScores = Object.fromEntries(MODELS.map((m) => [m.name, 0]));

let initialCompleted: RoundState[] = [];
if (allRounds.length > 0) {
  for (const round of allRounds) {
    if (round.scoreA !== undefined && round.scoreB !== undefined) {
      if (round.scoreA > round.scoreB) {
        initialScores[round.contestants[0].name] =
          (initialScores[round.contestants[0].name] || 0) + 1;
      } else if (round.scoreB > round.scoreA) {
        initialScores[round.contestants[1].name] =
          (initialScores[round.contestants[1].name] || 0) + 1;
      }
    }
  }
  const lastRound = allRounds[allRounds.length - 1];
  if (lastRound) {
    initialCompleted = [lastRound];
  }
}

const gameState: GameState = {
  completed: initialCompleted,
  active: null,
  scores: initialScores,
  done: false,
  isPaused: false,
  generation: 0,
};

// ── Guardrails ──────────────────────────────────────────────────────────────

type WsData = { ip: string };

const WINDOW_MS = 60_000;
const HISTORY_LIMIT_PER_MIN = parsePositiveInt(
  process.env.HISTORY_LIMIT_PER_MIN,
  120,
);
const ADMIN_LIMIT_PER_MIN = parsePositiveInt(
  process.env.ADMIN_LIMIT_PER_MIN,
  10,
);
const MAX_WS_GLOBAL = parsePositiveInt(process.env.MAX_WS_GLOBAL, 100_000);
const MAX_WS_PER_IP = parsePositiveInt(process.env.MAX_WS_PER_IP, 8);
const MAX_WS_NEW_PER_SEC = parsePositiveInt(process.env.MAX_WS_NEW_PER_SEC, 50);
let wsNewConnections = 0;
let wsNewConnectionsResetAt = Date.now() + 1000;
const MAX_HISTORY_PAGE = parsePositiveInt(
  process.env.MAX_HISTORY_PAGE,
  100_000,
);
const MAX_HISTORY_LIMIT = parsePositiveInt(process.env.MAX_HISTORY_LIMIT, 50);
const HISTORY_CACHE_TTL_MS = parsePositiveInt(
  process.env.HISTORY_CACHE_TTL_MS,
  5_000,
);
const MAX_HISTORY_CACHE_KEYS = parsePositiveInt(
  process.env.MAX_HISTORY_CACHE_KEYS,
  500,
);
const FOSSABOT_CHANNEL_LOGIN = (
  process.env.FOSSABOT_CHANNEL_LOGIN ?? "quipslop"
).trim().toLowerCase();
const FOSSABOT_VOTE_SECRET = process.env.FOSSABOT_VOTE_SECRET ?? "";
const FOSSABOT_VALIDATE_TIMEOUT_MS = parsePositiveInt(
  process.env.FOSSABOT_VALIDATE_TIMEOUT_MS,
  1_500,
);
const VIEWER_VOTE_BROADCAST_DEBOUNCE_MS = parsePositiveInt(
  process.env.VIEWER_VOTE_BROADCAST_DEBOUNCE_MS,
  250,
);
const ADMIN_COOKIE = "quipslop_admin";
const ADMIN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const requestWindows = new Map<string, number[]>();
const wsByIp = new Map<string, number>();
const historyCache = new Map<string, { body: string; expiresAt: number }>();
let lastRateWindowSweep = 0;
let lastHistoryCacheSweep = 0;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (v4 === "127.0.0.1" || ip === "::1") return true;
  if (v4.startsWith("10.")) return true;
  if (v4.startsWith("192.168.")) return true;
  // CGNAT range (RFC 6598) — used by Railway's internal proxy
  if (v4.startsWith("100.")) {
    const second = parseInt(v4.split(".")[1] ?? "", 10);
    if (second >= 64 && second <= 127) return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (v4.startsWith("172.")) {
    const second = parseInt(v4.split(".")[1] ?? "", 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function getClientIp(req: Request, server: Bun.Server<WsData>): string {
  const socketIp = server.requestIP(req)?.address ?? "unknown";

  // Only trust proxy headers when the direct connection comes from
  // a private IP (i.e. Railway's edge proxy). Direct public connections
  // cannot spoof their IP this way.
  if (socketIp !== "unknown" && isPrivateIp(socketIp)) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const rightmost = xff.split(",").at(-1)?.trim();
      if (rightmost && !isPrivateIp(rightmost)) {
        return rightmost.startsWith("::ffff:") ? rightmost.slice(7) : rightmost;
      }
    }
  }

  return socketIp.startsWith("::ffff:") ? socketIp.slice(7) : socketIp;
}

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (now - lastRateWindowSweep >= windowMs) {
    for (const [bucketKey, timestamps] of requestWindows) {
      const recent = timestamps.filter(
        (timestamp) => now - timestamp <= windowMs,
      );
      if (recent.length === 0) {
        requestWindows.delete(bucketKey);
      } else {
        requestWindows.set(bucketKey, recent);
      }
    }
    lastRateWindowSweep = now;
  }

  const existing = requestWindows.get(key) ?? [];
  const recent = existing.filter((timestamp) => now - timestamp <= windowMs);
  if (recent.length >= limit) {
    requestWindows.set(key, recent);
    return true;
  }
  recent.push(now);
  requestWindows.set(key, recent);
  return false;
}

function secureCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get("cookie");
  if (!raw) return {};
  const cookies: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

function buildAdminCookie(
  passcode: string,
  isSecure: boolean,
  maxAgeSeconds = ADMIN_COOKIE_MAX_AGE_SECONDS,
): string {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(passcode)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearAdminCookie(isSecure: boolean): string {
  return buildAdminCookie("", isSecure, 0);
}

function getProvidedAdminSecret(req: Request, url: URL): string {
  const headerOrQuery =
    req.headers.get("x-admin-secret") ?? url.searchParams.get("secret");
  if (headerOrQuery) return headerOrQuery;
  const cookies = parseCookies(req);
  return cookies[ADMIN_COOKIE] ?? "";
}

function isAdminAuthorized(req: Request, url: URL): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;
  const provided = getProvidedAdminSecret(req, url);
  if (!provided) return false;
  return secureCompare(provided, expected);
}

function decrementIpConnection(ip: string) {
  const current = wsByIp.get(ip) ?? 0;
  if (current <= 1) {
    wsByIp.delete(ip);
    return;
  }
  wsByIp.set(ip, current - 1);
}

function setHistoryCache(key: string, body: string, expiresAt: number) {
  if (historyCache.size >= MAX_HISTORY_CACHE_KEYS) {
    const firstKey = historyCache.keys().next().value;
    if (firstKey) historyCache.delete(firstKey);
  }
  historyCache.set(key, { body, expiresAt });
}

type ViewerVoteSide = "A" | "B";

function isValidFossabotValidateUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.host === "api.fossabot.com" &&
      url.pathname.startsWith("/v2/customapi/validate/")
    );
  } catch {
    return false;
  }
}

async function validateFossabotRequest(validateUrl: string): Promise<boolean> {
  if (!isValidFossabotValidateUrl(validateUrl)) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    FOSSABOT_VALIDATE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(validateUrl, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return false;

    const body = (await res.json().catch(() => null)) as
      | { context_url?: unknown }
      | null;
    return Boolean(body && typeof body.context_url === "string");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function applyViewerVote(voterId: string, side: ViewerVoteSide): boolean {
  const round = gameState.active;
  if (!round || round.phase !== "voting") return false;
  if (!round.viewerVotingEndsAt || Date.now() > round.viewerVotingEndsAt) {
    return false;
  }

  const previousVote = viewerVoters.get(voterId);
  if (previousVote === side) return false;

  // Undo previous vote if this viewer switched sides.
  if (previousVote === "A") {
    round.viewerVotesA = Math.max(0, (round.viewerVotesA ?? 0) - 1);
  } else if (previousVote === "B") {
    round.viewerVotesB = Math.max(0, (round.viewerVotesB ?? 0) - 1);
  }

  viewerVoters.set(voterId, side);
  if (side === "A") {
    round.viewerVotesA = (round.viewerVotesA ?? 0) + 1;
  } else {
    round.viewerVotesB = (round.viewerVotesB ?? 0) + 1;
  }
  return true;
}

// ── WebSocket clients ───────────────────────────────────────────────────────

const clients = new Set<ServerWebSocket<WsData>>();
const viewerVoters = new Map<string, "A" | "B">();
let viewerVoteBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleViewerVoteBroadcast() {
  if (viewerVoteBroadcastTimer) return;
  viewerVoteBroadcastTimer = setTimeout(() => {
    viewerVoteBroadcastTimer = null;
    broadcast();
  }, VIEWER_VOTE_BROADCAST_DEBOUNCE_MS);
}

function getClientState() {
  return {
    active: gameState.active,
    lastCompleted: gameState.completed.at(-1) ?? null,
    scores: gameState.scores,
    done: gameState.done,
    isPaused: gameState.isPaused,
    generation: gameState.generation,
  };
}

function broadcast() {
  const msg = JSON.stringify({
    type: "state",
    data: getClientState(),
    totalRounds: runs,
    viewerCount: clients.size,
    version: VERSION,
  });
  for (const ws of clients) {
    ws.send(msg);
  }
}

let viewerCountTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastViewerCount() {
  if (viewerCountTimer) return;
  viewerCountTimer = setTimeout(() => {
    viewerCountTimer = null;
    const msg = JSON.stringify({
      type: "viewerCount",
      viewerCount: clients.size,
    });
    for (const ws of clients) {
      ws.send(msg);
    }
  }, 15_000);
}

function getAdminSnapshot() {
  return {
    isPaused: gameState.isPaused,
    isRunningRound: Boolean(gameState.active),
    done: gameState.done,
    completedInMemory: gameState.completed.length,
    persistedRounds: getRounds(1, 1).total,
    viewerCount: clients.size,
  };
}

// ── Server ──────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? "5109", 10); // 5109 = SLOP

const server = Bun.serve<WsData>({
  port,
  routes: {
    "/": indexHtml,
    "/history": historyHtml,
    "/admin": adminHtml,
    "/broadcast": broadcastHtml,
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const ip = getClientIp(req, server);

    if (url.pathname.startsWith("/assets/")) {
      const path = `./public${url.pathname}`;
      const file = Bun.file(path);
      return new Response(file, {
        headers: {
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (
      url.pathname === "/api/fossabot/vote/1" ||
      url.pathname === "/api/fossabot/vote/2"
    ) {
      if (req.method !== "GET") {
        return new Response("", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if (!FOSSABOT_VOTE_SECRET) {
        log("ERROR", "vote:fossabot", "FOSSABOT_VOTE_SECRET is not configured");
        return new Response("", { status: 503 });
      }

      const providedSecret = url.searchParams.get("secret") ?? "";
      if (!providedSecret || !secureCompare(providedSecret, FOSSABOT_VOTE_SECRET)) {
        log("WARN", "vote:fossabot", "Rejected due to missing/invalid secret", {
          ip,
        });
        return new Response("", { status: 401 });
      }

      const channelProvider = req.headers
        .get("x-fossabot-channelprovider")
        ?.trim()
        .toLowerCase();
      const channelLogin = req.headers
        .get("x-fossabot-channellogin")
        ?.trim()
        .toLowerCase();
      if (channelProvider !== "twitch" || channelLogin !== FOSSABOT_CHANNEL_LOGIN) {
        log("WARN", "vote:fossabot", "Rejected due to channel/provider mismatch", {
          ip,
          channelProvider,
          channelLogin,
        });
        return new Response("", { status: 403 });
      }

      const validateUrl = req.headers.get("x-fossabot-validateurl") ?? "";
      const isValid = await validateFossabotRequest(validateUrl);
      if (!isValid) {
        log("WARN", "vote:fossabot", "Validation check failed", { ip });
        return new Response("", { status: 401 });
      }

      const userProvider = req.headers
        .get("x-fossabot-message-userprovider")
        ?.trim()
        .toLowerCase();
      if (userProvider && userProvider !== "twitch") {
        return new Response("", { status: 403 });
      }

      const userProviderId = req.headers
        .get("x-fossabot-message-userproviderid")
        ?.trim();
      if (!userProviderId) {
        log("WARN", "vote:fossabot", "Missing user provider ID", { ip });
        return new Response("", { status: 400 });
      }

      const votedFor: ViewerVoteSide = url.pathname.endsWith("/1") ? "A" : "B";
      const applied = applyViewerVote(userProviderId, votedFor);
      if (applied) {
        scheduleViewerVoteBroadcast();
      }
      return new Response("", {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/login") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        log("WARN", "http", "Admin login rate limited", { ip });
        return new Response("Too Many Requests", { status: 429 });
      }

      const expected = process.env.ADMIN_SECRET;
      if (!expected) {
        return new Response("ADMIN_SECRET is not configured", { status: 503 });
      }

      let passcode = "";
      try {
        const body = await req.json();
        passcode = String((body as Record<string, unknown>).passcode ?? "");
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }

      if (!passcode || !secureCompare(passcode, expected)) {
        return new Response("Invalid passcode", { status: 401 });
      }

      const isSecure = url.protocol === "https:";
      return new Response(JSON.stringify({ ok: true, ...getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": buildAdminCookie(passcode, isSecure),
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/logout") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      const isSecure = url.protocol === "https:";
      return new Response(null, {
        status: 204,
        headers: {
          "Set-Cookie": clearAdminCookie(isSecure),
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/status") {
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, ...getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/admin/export") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const payload = {
        exportedAt: new Date().toISOString(),
        rounds: getAllRounds(),
        state: gameState,
      };
      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="quipslop-export-${Date.now()}.json"`,
        },
      });
    }

    if (url.pathname === "/api/admin/reset") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let confirm = "";
      try {
        const body = await req.json();
        confirm = String((body as Record<string, unknown>).confirm ?? "");
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      if (confirm !== "RESET") {
        return new Response("Confirmation token must be RESET", {
          status: 400,
        });
      }

      clearAllRounds();
      historyCache.clear();
      gameState.completed = [];
      gameState.active = null;
      gameState.scores = Object.fromEntries(MODELS.map((m) => [m.name, 0]));
      gameState.done = false;
      gameState.isPaused = true;
      gameState.generation += 1;
      broadcast();

      log("WARN", "admin", "Database reset requested", { ip });
      return new Response(JSON.stringify({ ok: true, ...getAdminSnapshot() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (
      url.pathname === "/api/pause" ||
      url.pathname === "/api/resume" ||
      url.pathname === "/api/admin/pause" ||
      url.pathname === "/api/admin/resume"
    ) {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname.endsWith("/pause")) {
        gameState.isPaused = true;
      } else {
        gameState.isPaused = false;
      }
      broadcast();
      const action = url.pathname.endsWith("/pause") ? "Paused" : "Resumed";
      if (url.pathname === "/api/pause" || url.pathname === "/api/resume") {
        return new Response(action, { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: true, action, ...getAdminSnapshot() }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/api/history") {
      if (isRateLimited(`history:${ip}`, HISTORY_LIMIT_PER_MIN, WINDOW_MS)) {
        log("WARN", "http", "History rate limited", { ip });
        return new Response("Too Many Requests", { status: 429 });
      }
      const rawPage = parseInt(url.searchParams.get("page") || "1", 10);
      const rawLimit = parseInt(url.searchParams.get("limit") || "10", 10);
      const page = Number.isFinite(rawPage)
        ? Math.min(Math.max(rawPage, 1), MAX_HISTORY_PAGE)
        : 1;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), MAX_HISTORY_LIMIT)
        : 10;
      const cacheKey = `${page}:${limit}`;
      const now = Date.now();
      if (now - lastHistoryCacheSweep >= HISTORY_CACHE_TTL_MS) {
        for (const [key, value] of historyCache) {
          if (value.expiresAt <= now) historyCache.delete(key);
        }
        lastHistoryCacheSweep = now;
      }
      const cached = historyCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return new Response(cached.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const body = JSON.stringify(getRounds(page, limit));
      setHistoryCache(cacheKey, body, now + HISTORY_CACHE_TTL_MS);
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/ws") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      const now = Date.now();
      if (now >= wsNewConnectionsResetAt) {
        wsNewConnections = 0;
        wsNewConnectionsResetAt = now + 1000;
      }
      if (wsNewConnections >= MAX_WS_NEW_PER_SEC) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (clients.size >= MAX_WS_GLOBAL) {
        log("WARN", "ws", "Global WS limit reached, rejecting", {
          ip,
          clients: clients.size,
          limit: MAX_WS_GLOBAL,
        });
        return new Response("Service Unavailable", { status: 503 });
      }
      const existingForIp = wsByIp.get(ip) ?? 0;
      if (existingForIp >= MAX_WS_PER_IP) {
        log("WARN", "ws", "Per-IP WS limit reached, rejecting", {
          ip,
          existing: existingForIp,
          limit: MAX_WS_PER_IP,
        });
        return new Response("Too Many Requests", { status: 429 });
      }

      const upgraded = server.upgrade(req, { data: { ip } });
      if (!upgraded) {
        log("WARN", "ws", "WebSocket upgrade failed", { ip });
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      wsNewConnections++;
      return undefined;
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    data: {} as WsData,
    open(ws) {
      clients.add(ws);
      const ipCount = (wsByIp.get(ws.data.ip) ?? 0) + 1;
      wsByIp.set(ws.data.ip, ipCount);
      log("INFO", "ws", "Client connected", {
        ip: ws.data.ip,
        ipConns: ipCount,
        totalClients: clients.size,
        uniqueIps: wsByIp.size,
      });
      // Send current state to the new client only
      ws.send(
        JSON.stringify({
          type: "state",
          data: getClientState(),
          totalRounds: runs,
          viewerCount: clients.size,
          version: VERSION,
        }),
      );
      // Notify everyone else with just the viewer count
      broadcastViewerCount();
    },
    message() {
      // Viewer voting moved to Twitch chat via Fossabot.
    },
    close(ws) {
      clients.delete(ws);
      decrementIpConnection(ws.data.ip);
      log("INFO", "ws", "Client disconnected", {
        ip: ws.data.ip,
        totalClients: clients.size,
        uniqueIps: wsByIp.size,
      });
      broadcastViewerCount();
    },
  },
  development:
    process.env.NODE_ENV === "production"
      ? false
      : {
          hmr: true,
          console: true,
        },
  error(error) {
    log("ERROR", "server", "Unhandled fetch/websocket error", {
      message: error.message,
      stack: error.stack,
    });
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\n🎮 quipslop Web — http://localhost:${server.port}`);
console.log(`📡 WebSocket — ws://localhost:${server.port}/ws`);
console.log(`🎯 ${runs} rounds with ${MODELS.length} models\n`);

log("INFO", "server", `Web server started on port ${server.port}`, {
  runs,
  models: MODELS.map((m) => m.id),
});

// ── Start game ──────────────────────────────────────────────────────────────

runGame(runs, gameState, broadcast, () => {
  viewerVoters.clear();
}).then(() => {
  console.log(`\n✅ Game complete! Log: ${LOG_FILE}`);
});
