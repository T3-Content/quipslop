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

const WIDTH = 1920;
const HEIGHT = 1080;

const canvas = document.getElementById("broadcast-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("broadcast-status") as HTMLDivElement;

function get2dContext(el: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = el.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable");
  return context;
}

const ctx = get2dContext(canvas);

let state: GameState | null = null;
let totalRounds: number | null = null;
let viewerCount = 0;
let connected = false;
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let lastMessageAt = 0;
let knownVersion: string | null = null;

function getColor(name: string): string {
  return MODEL_COLORS[name] ?? "#aeb6d6";
}

function getLogoUrl(name: string): string | null {
  if (name.includes("Gemini")) return "/assets/logos/gemini.svg";
  if (name.includes("Kimi")) return "/assets/logos/kimi.svg";
  if (name.includes("DeepSeek")) return "/assets/logos/deepseek.svg";
  if (name.includes("GLM")) return "/assets/logos/glm.svg";
  if (name.includes("GPT")) return "/assets/logos/openai.svg";
  if (name.includes("Opus") || name.includes("Sonnet")) return "/assets/logos/claude.svg";
  if (name.includes("Grok")) return "/assets/logos/grok.svg";
  if (name.includes("MiniMax")) return "/assets/logos/minimax.svg";
  return null;
}

const logoCache: Record<string, HTMLImageElement> = {};
function drawModelLogo(name: string, x: number, y: number, size: number): boolean {
  const url = getLogoUrl(name);
  if (!url) return false;
  if (!logoCache[url]) {
    const img = new Image();
    img.src = url;
    logoCache[url] = img;
  }
  const img = logoCache[url];
  if (img.complete && img.naturalHeight !== 0) {
    ctx.drawImage(img, x, y, size, size);
    return true;
  }
  return false;
}

function setupWebSocket() {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    connected = true;
    setStatus("WS connected");
  };

  ws.onclose = () => {
    connected = false;
    setStatus("WS reconnecting...");
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(setupWebSocket, 1_000);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === "state") {
        if (msg.version) {
          if (!knownVersion) knownVersion = msg.version;
          else if (knownVersion !== msg.version) return location.reload();
        }
        state = msg.data;
        totalRounds =
          Number.isFinite(msg.totalRounds) && msg.totalRounds >= 0
            ? msg.totalRounds
            : null;
        viewerCount = msg.viewerCount;
        lastMessageAt = Date.now();
      } else if (msg.type === "viewerCount") {
        viewerCount = msg.viewerCount;
      }
    } catch {
      // Ignore malformed spectator payloads.
    }
  };
}

function setStatus(value: string) {
  statusEl.textContent = value;
}

function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fillStyle: string,
) {
  const p = new Path2D();
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r);
  p.quadraticCurveTo(x, y, x + r, y);
  ctx.fillStyle = fillStyle;
  ctx.fill(p);
}

function textLines(
  text: string,
  maxWidth: number,
  font: string,
  maxLines = 3,
): string[] {
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }

  if (current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (words.length > 0 && lines.length === maxLines) {
    const last = lines[maxLines - 1] ?? "";
    if (ctx.measureText(last).width > maxWidth) {
      let trimmed = last;
      while (trimmed.length > 3 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
        trimmed = trimmed.slice(0, -1);
      }
      lines[maxLines - 1] = `${trimmed}...`;
    }
  }

  return lines;
}

function drawTextBlock(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  font: string,
  color: string,
  maxLines: number,
) {
  const lines = textLines(text, maxWidth, font, maxLines);
  ctx.font = font;
  ctx.fillStyle = color;
  lines.forEach((line, idx) => {
    ctx.fillText(line, x, y + idx * lineHeight);
  });
}

function drawHeader() {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.font = '700 40px "Inter", sans-serif';
  ctx.fillStyle = "#ededed";
  ctx.fillText("quipslop", 48, 76);

}

function drawScoreboard(scores: Record<string, number>) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  
  roundRect(WIDTH - 380, 0, 380, HEIGHT, 0, "#111");
  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(WIDTH - 380, 0, 1, HEIGHT);

  ctx.font = '700 18px "JetBrains Mono", monospace';
  ctx.fillStyle = "#888";
  ctx.fillText("STANDINGS", WIDTH - 348, 76);

  const maxScore = entries[0]?.[1] || 1;

  entries.slice(0, 10).forEach(([name, score], index) => {
    const y = 140 + index * 68;
    const color = getColor(name);
    const pct = maxScore > 0 ? (score / maxScore) : 0;

    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillStyle = "#888";
    const rank = index === 0 && score > 0 ? "👑" : String(index + 1);
    ctx.fillText(rank, WIDTH - 348, y + 24);

    ctx.font = '600 20px "Inter", sans-serif';
    ctx.fillStyle = color;
    const nameText = name.length > 18 ? `${name.slice(0, 18)}...` : name;

    const drewLogo = drawModelLogo(name, WIDTH - 304, y + 6, 24);
    if (drewLogo) {
      ctx.fillText(nameText, WIDTH - 304 + 32, y + 24);
    } else {
      ctx.fillText(nameText, WIDTH - 304, y + 24);
    }

    roundRect(WIDTH - 304, y + 42, 208, 4, 2, "#1c1c1c");
    if (pct > 0) {
      roundRect(WIDTH - 304, y + 42, Math.max(8, 208 * pct), 4, 2, color);
    }

    ctx.font = '700 20px "JetBrains Mono", monospace';
    ctx.fillStyle = "#888";
    const scoreText = String(score);
    const scoreWidth = ctx.measureText(scoreText).width;
    ctx.fillText(scoreText, WIDTH - 48 - scoreWidth, y + 24);
  });
}

function drawRound(round: RoundState) {
  const mainW = WIDTH - 380;

  const phaseLabel =
    (round.phase === "prompting"
      ? "Writing prompt"
      : round.phase === "answering"
        ? "Answering"
        : round.phase === "voting"
          ? "Judges voting"
          : "Complete"
    ).toUpperCase();

  ctx.font = '700 22px "JetBrains Mono", monospace';
  ctx.fillStyle = "#ededed";
  const totalText = totalRounds !== null ? `/${totalRounds}` : "";
  ctx.fillText(`Round ${round.num}${totalText}`, 64, 150);

  ctx.fillStyle = "#888";
  const labelWidth = ctx.measureText(phaseLabel).width;
  ctx.fillText(phaseLabel, mainW - 64 - labelWidth, 150);

  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillStyle = "#888";
  const promptedText = "PROMPTED BY ";
  ctx.fillText(promptedText, 64, 210);

  const pTw = ctx.measureText(promptedText).width;
  ctx.fillStyle = getColor(round.prompter.name);
  const drewPLogo = drawModelLogo(round.prompter.name, 64 + pTw, 210 - 14, 20);

  if (drewPLogo) {
    ctx.fillText(round.prompter.name.toUpperCase(), 64 + pTw + 24, 210);
  } else {
    ctx.fillText(round.prompter.name.toUpperCase(), 64 + pTw, 210);
  }

  const promptText =
    round.prompt ??
    (round.phase === "prompting" ? "Generating prompt..." : "Prompt unavailable");

  const promptFont = '400 56px "DM Serif Display", serif';
  const promptLineHeight = 72;
  const promptMaxLines = 3;
  const promptMaxWidth = mainW - 120;
  const promptLines = textLines(promptText, promptMaxWidth, promptFont, promptMaxLines);
  const promptTextHeight = promptLines.length * promptLineHeight;
  const promptBaselineY = 262;
  const promptBarY = promptBaselineY - 44;

  ctx.fillStyle = getColor(round.prompter.name);
  ctx.fillRect(64, promptBarY, 4, promptTextHeight + 6);

  drawTextBlock(
    promptText,
    80,
    promptBaselineY,
    promptMaxWidth,
    promptLineHeight,
    promptFont,
    round.prompt ? "#ededed" : "#444",
    promptMaxLines,
  );

  if (round.phase !== "prompting") {
    const [taskA, taskB] = round.answerTasks;
    const cardW = (mainW - 160) / 2;
    const cardY = promptBarY + promptTextHeight + 6 + 32;
    const cardH = HEIGHT - cardY - 40;
    drawContestantCard(taskA, 64, cardY, cardW, cardH, round);
    drawContestantCard(taskB, 64 + cardW + 32, cardY, cardW, cardH, round);
  }
}

function drawContestantCard(
  task: TaskInfo,
  x: number,
  y: number,
  w: number,
  h: number,
  round: RoundState,
) {
  const [a, b] = round.contestants;
  let votesA = 0;
  let votesB = 0;
  const taskVoters: VoteInfo[] = [];
  for (const vote of round.votes) {
    if (vote.votedFor?.name === a.name) votesA += 1;
    if (vote.votedFor?.name === b.name) votesB += 1;
    if (vote.votedFor?.name === task.model.name) taskVoters.push(vote);
  }
  const isFirst = round.answerTasks[0].model.name === task.model.name;
  const voteCount = isFirst ? votesA : votesB;
  const isWinner = round.phase === "done" && voteCount > (isFirst ? votesB : votesA);
  
  const color = getColor(task.model.name);
  
  ctx.fillStyle = color;
  ctx.fillRect(x, y, isWinner ? 6 : 4, h);
  
  if (isWinner) {
    roundRect(x, y, w, h, 0, "rgba(255,255,255,0.03)");
  }

  ctx.font = '700 32px "Inter", sans-serif';
  ctx.fillStyle = color;
  const drewCLogo = drawModelLogo(task.model.name, x + 24, y + 16, 32);
  if (drewCLogo) {
    ctx.fillText(task.model.name, x + 64, y + 44);
  } else {
    ctx.fillText(task.model.name, x + 24, y + 44);
  }

  if (isWinner) {
    ctx.font = '700 18px "JetBrains Mono", monospace';
    ctx.fillStyle = "#0a0a0a";
    const winW = ctx.measureText("WIN").width;
    roundRect(x + w - 24 - winW - 24, y + 16, winW + 24, 36, 6, "#ededed");
    ctx.fillStyle = "#0a0a0a";
    ctx.fillText("WIN", x + w - 24 - winW - 12, y + 40);
  }

  const answer =
    !task.finishedAt && !task.result
      ? "Writing answer..."
      : task.error
        ? task.error
        : task.result ?? "No answer";

  drawTextBlock(
    task.result ? `"${answer}"` : answer,
    x + 24,
    y + 120,
    w - 48,
    52,
    '400 40px "DM Serif Display", serif',
    isWinner ? "#ededed" : (!task.finishedAt && !task.result ? "#444" : "#888"),
    6,
  );

  const showVotes = round.phase === "voting" || round.phase === "done";
  if (showVotes) {
    const totalVotes = votesA + votesB;
    const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;

    roundRect(x + 24, y + h - 60, w - 48, 4, 2, "#1c1c1c");
    if (pct > 0) {
      roundRect(x + 24, y + h - 60, Math.max(8, ((w - 48) * pct) / 100), 4, 2, color);
    }

    ctx.font = '700 28px "JetBrains Mono", monospace';
    ctx.fillStyle = color;
    ctx.fillText(String(voteCount), x + 24, y + h - 24);

    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillStyle = "#444";
    const vTxt = `vote${voteCount === 1 ? "" : "s"}`;
    const vCountW = ctx.measureText(String(voteCount)).width;
    const vTxtW = ctx.measureText(vTxt).width;
    ctx.fillText(vTxt, x + 24 + vCountW + 8, y + h - 25);

    let avatarX = x + 24 + vCountW + 8 + vTxtW + 16;
    const avatarY = y + h - 48;
    const avatarSize = 28;

    for (const v of taskVoters) {
      const vColor = getColor(v.voter.name);
      const drewLogo = drawModelLogo(v.voter.name, avatarX, avatarY, avatarSize);
      
      if (!drewLogo) {
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = vColor;
        ctx.fill();
        ctx.font = '700 12px "Inter", sans-serif';
        ctx.fillStyle = "#0a0a0a";
        const initial = v.voter.name[0] ?? "?";
        const tw = ctx.measureText(initial).width;
        ctx.fillText(initial, avatarX + avatarSize / 2 - tw / 2, avatarY + avatarSize / 2 + 4);
      }
      
      avatarX += avatarSize + 8;
    }
  }
}

function drawWaiting() {
  const mainW = WIDTH - 380;
  ctx.font = '400 48px "DM Serif Display", serif';
  ctx.fillStyle = "#888";
  const text = "Waiting for game state...";
  const tw = ctx.measureText(text).width;
  ctx.fillText(text, (mainW - tw) / 2, HEIGHT / 2);
}

function drawDone(scores: Record<string, number>) {
  const mainW = WIDTH - 380;
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!winner) return;
  const [name, points] = winner;
  
  ctx.font = '700 20px "JetBrains Mono", monospace';
  ctx.fillStyle = "#444";
  const go = "GAME OVER";
  const gow = ctx.measureText(go).width;
  ctx.fillText(go, (mainW - gow) / 2, HEIGHT / 2 - 100);

  ctx.font = '400 80px "DM Serif Display", serif';
  ctx.fillStyle = getColor(name);
  const nw = ctx.measureText(name).width;
  ctx.fillText(name, (mainW - nw) / 2, HEIGHT / 2);

  ctx.font = '600 24px "Inter", sans-serif';
  ctx.fillStyle = "#888";
  const wins = `is the funniest AI`;
  const ww = ctx.measureText(wins).width;
  ctx.fillText(wins, (mainW - ww) / 2, HEIGHT / 2 + 60);
}

function draw() {
  drawHeader();
  if (!state) {
    drawWaiting();
      return;
  }

  drawScoreboard(state.scores);
  
  const isNextPrompting = state.active?.phase === "prompting" && !state.active.prompt;
  const displayRound = isNextPrompting && state.lastCompleted ? state.lastCompleted : (state.active ?? state.lastCompleted ?? null);

  if (state.done) {
    drawDone(state.scores);
  } else if (displayRound) {
    drawRound(displayRound);
  } else {
    drawWaiting();
  }
}

function renderLoop() {
  draw();
  window.requestAnimationFrame(renderLoop);
}

function startCanvasCaptureSink() {
  const params = new URLSearchParams(window.location.search);
  const sink = params.get("sink");
  if (!sink) return;

  if (!("MediaRecorder" in window)) {
    setStatus("MediaRecorder unavailable");
    return;
  }

  const fps = Number.parseInt(params.get("captureFps") ?? "30", 10);
  const bitRate = Number.parseInt(params.get("captureBitrate") ?? "12000000", 10);
  const stream = canvas.captureStream(Number.isFinite(fps) && fps > 0 ? fps : 30);
  const socket = new WebSocket(sink);
  socket.binaryType = "arraybuffer";

  let recorder: MediaRecorder | null = null;
  const mimeCandidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  const mimeType =
    mimeCandidates.find((value) => MediaRecorder.isTypeSupported(value)) ?? "";

  socket.onopen = () => {
    const options: MediaRecorderOptions = {
      videoBitsPerSecond: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : 12_000_000,
    };
    if (mimeType) options.mimeType = mimeType;

    recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = async (event) => {
      if (event.data.size === 0) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 16_000_000) return;
      const chunk = await event.data.arrayBuffer();
      socket.send(chunk);
    };
    recorder.onerror = () => {
      setStatus("Recorder error");
    };
    recorder.start(250);
    setStatus(`capture->ws ${fps}fps`);
  };

  socket.onclose = () => {
    recorder?.stop();
    setStatus("capture sink closed");
  };
}

setupWebSocket();
startCanvasCaptureSink();
renderLoop();
