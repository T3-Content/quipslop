import tmi from "tmi.js";
import { log } from "./game.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type ChatMessage = {
  id: string;
  username: string;
  displayName: string;
  content: string;
  timestamp: number;
  badges: Record<string, string>;
  isSubscriber: boolean;
  isMod: boolean;
  roundNum: number | null;
};

export type ChatStats = {
  totalMessages: number;
  uniqueChatters: number;
  messagesPerMinute: number;
  topChatters: { username: string; count: number }[];
};

type ChatListener = (message: ChatMessage) => void;

// ── Config ──────────────────────────────────────────────────────────────────

const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL ?? "quipslop";
const MIN_MESSAGE_LENGTH = 2;
const BUFFER_WINDOW_MS = 60_000;
const STATS_TOP_N = 10;

// ── Chat client ─────────────────────────────────────────────────────────────

const listeners: ChatListener[] = [];
const recentMessages: ChatMessage[] = [];
const chatterCounts = new Map<string, number>();
let totalMessages = 0;
let currentRoundNum: number | null = null;
let client: tmi.Client | null = null;

function isSpam(content: string): boolean {
  const trimmed = content.trim();

  // Allow single-char vote messages (A, B, 1, 2) through the filter
  if (/^[AB12]$/i.test(trimmed)) return false;

  if (trimmed.length < MIN_MESSAGE_LENGTH) return true;

  // Pure emote spam or repeated single characters
  if (/^(.)\1{4,}$/.test(trimmed)) return true;

  // Common Twitch spam patterns
  if (/^(lul|kekw|omegalul|poggers|copium|pepega|monkas|sadge|widepeepo)\s*$/i.test(trimmed)) return true;

  // Bot commands
  if (trimmed.startsWith("!")) return true;

  // URL spam
  if (/https?:\/\/\S+/i.test(trimmed)) return true;

  // Excessive caps (>80% uppercase, 10+ chars)
  if (trimmed.length >= 10) {
    const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
    if (upperCount / trimmed.length > 0.8) return true;
  }

  return false;
}

export function onChatMessage(listener: ChatListener) {
  listeners.push(listener);
}

export function setCurrentRound(roundNum: number | null) {
  currentRoundNum = roundNum;
}

export function getRecentMessages(limit = 50): ChatMessage[] {
  if (limit <= 0) return [];
  return recentMessages.slice(-limit);
}

export function getChatStats(): ChatStats {
  const now = Date.now();
  const windowMessages = recentMessages.filter(
    (m) => now - m.timestamp <= BUFFER_WINDOW_MS,
  );

  const sorted = [...chatterCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, STATS_TOP_N)
    .map(([username, count]) => ({ username, count }));

  return {
    totalMessages,
    uniqueChatters: chatterCounts.size,
    messagesPerMinute: windowMessages.length,
    topChatters: sorted,
  };
}

export async function startChat(): Promise<void> {
  const username = process.env.TWITCH_BOT_USERNAME;
  const password = process.env.TWITCH_OAUTH_TOKEN;

  const identity =
    username && password ? { username, password } : undefined;

  client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity,
    channels: [TWITCH_CHANNEL],
  });

  client.on("message", (_channel, tags, message, _self) => {
    if (isSpam(message)) return;

    const chatMessage: ChatMessage = {
      id: tags.id ?? crypto.randomUUID(),
      username: tags.username ?? "anonymous",
      displayName: tags["display-name"] ?? tags.username ?? "anonymous",
      content: message.trim(),
      timestamp: Number(tags["tmi-sent-ts"]) || Date.now(),
      badges: (tags.badges as Record<string, string>) ?? {},
      isSubscriber: Boolean(tags.subscriber),
      isMod: Boolean(tags.mod),
      roundNum: currentRoundNum,
    };

    totalMessages++;
    recentMessages.push(chatMessage);
    chatterCounts.set(
      chatMessage.username,
      (chatterCounts.get(chatMessage.username) ?? 0) + 1,
    );

    // Trim buffer to last 500 messages
    if (recentMessages.length > 500) {
      recentMessages.splice(0, recentMessages.length - 500);
    }

    for (const listener of listeners) {
      try {
        listener(chatMessage);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("ERROR", "chat", "Listener error", { error: detail });
      }
    }
  });

  client.on("connected", (addr, port) => {
    log("INFO", "chat", `Connected to Twitch IRC`, {
      address: addr,
      port,
      channel: TWITCH_CHANNEL,
      authenticated: Boolean(identity),
    });
  });

  client.on("disconnected", (reason) => {
    log("WARN", "chat", "Disconnected from Twitch IRC", { reason });
  });

  try {
    await client.connect();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log("ERROR", "chat", "Failed to connect to Twitch IRC", {
      error: detail,
      channel: TWITCH_CHANNEL,
    });
  }
}

// ── Audience voting ─────────────────────────────────────────────────────────

type AudienceVotes = { a: number; b: number; voters: Set<string> };

let audienceVotes: AudienceVotes = { a: 0, b: 0, voters: new Set() };
let votingOpen = false;

export function openAudienceVoting() {
  audienceVotes = { a: 0, b: 0, voters: new Set() };
  votingOpen = true;
}

export function closeAudienceVoting(): { a: number; b: number } {
  votingOpen = false;
  return { a: audienceVotes.a, b: audienceVotes.b };
}

export function getAudienceVotes(): { a: number; b: number; total: number } {
  return {
    a: audienceVotes.a,
    b: audienceVotes.b,
    total: audienceVotes.a + audienceVotes.b,
  };
}

// Accepts: "A", "a", "1", "A!", "a lol" — first non-punctuation char wins
// Note: "vote A" won't match because 'v' is alphanumeric
function processVote(username: string, content: string) {
  if (!votingOpen) return;
  if (audienceVotes.voters.has(username)) return; // one vote per person

  const match = content.trim().match(/^[^a-z0-9]*([ab12])/i);
  if (!match) return;

  const vote = match[1]!.toUpperCase();
  if (vote === "A" || vote === "1") {
    audienceVotes.a++;
    audienceVotes.voters.add(username);
  } else if (vote === "B" || vote === "2") {
    audienceVotes.b++;
    audienceVotes.voters.add(username);
  }
}

// Hook vote detection into message pipeline
onChatMessage((msg) => processVote(msg.username, msg.content));

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function stopChat() {
  if (client) {
    await client.disconnect().catch(() => {});
    client = null;
  }
}
