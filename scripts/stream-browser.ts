import puppeteer from "puppeteer";

type Mode = "live" | "dryrun";

type SinkWriter = {
  write(chunk: Uint8Array): number;
  end(error?: Error): number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function usage(): never {
  console.error("Usage: bun scripts/stream-browser.ts <live|dryrun>");
  console.error("Required for live mode: TWITCH_STREAM_KEY");
  process.exit(1);
}

function resolveMode(value: string | undefined): Mode {
  if (value === "live" || value === "dryrun") return value;
  return usage();
}

const mode = resolveMode(process.argv[2]);

const streamFps = parsePositiveInt(process.env.STREAM_FPS, 30);
const captureBitrate = parsePositiveInt(process.env.STREAM_CAPTURE_BITRATE, 12_000_000);
const targetSize = process.env.STREAM_TARGET_SIZE ?? "1920x1080";
const targetParts = targetSize.split("x");
const targetWidth = targetParts[0] ?? "1920";
const targetHeight = targetParts[1] ?? "1080";
const videoBitrate = process.env.STREAM_VIDEO_BITRATE ?? "6000k";
const maxrate = process.env.STREAM_MAXRATE ?? "6000k";
const bufsize = process.env.STREAM_BUFSIZE ?? "12000k";
const gop = String(parsePositiveInt(process.env.STREAM_GOP, 60));
const audioBitrate = process.env.STREAM_AUDIO_BITRATE ?? "160k";
const streamKey = process.env.TWITCH_STREAM_KEY;
const serverPort = process.env.STREAM_APP_PORT ?? "5109";
const broadcastUrl = process.env.BROADCAST_URL ?? `http://127.0.0.1:${serverPort}/broadcast`;
const redactionTokens = [
  broadcastUrl,
  streamKey,
  streamKey ? encodeURIComponent(streamKey) : undefined,
  streamKey ? `rtmp://live.twitch.tv/app/${streamKey}` : undefined,
].filter((token): token is string => Boolean(token));
const redactionWindow = Math.max(1, ...redactionTokens.map((token) => token.length));

function redactSensitive(value: string): string {
  let output = value;
  for (const token of redactionTokens) {
    output = output.split(token).join("[REDACTED]");
  }
  return output;
}

if (mode === "live" && !streamKey) {
  console.error("TWITCH_STREAM_KEY is not set.");
  process.exit(1);
}

async function assertBroadcastReachable(url: string) {
  const timeoutMs = 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach broadcast page (${redactSensitive(detail)}). Start the app server first (bun run start or bun run start:web).`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildFfmpegArgs(currentMode: Mode): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "+genpts",
    "-f",
    "webm",
    "-i",
    "pipe:0",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    videoBitrate,
    "-maxrate",
    maxrate,
    "-bufsize",
    bufsize,
    "-g",
    gop,
    "-keyint_min",
    gop,
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-ar",
    "44100",
    "-ac",
    "2",
  ];

  if (currentMode === "live") {
    args.push("-f", "flv", `rtmp://live.twitch.tv/app/${streamKey}`);
    return args;
  }

  args.push("-f", "mpegts", "pipe:1");
  return args;
}

async function pipeReadableToSink(
  readable: ReadableStream<Uint8Array>,
  sink: SinkWriter,
) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink.write(value);
    }
  } finally {
    sink.end();
  }
}

async function pipeReadableToRedactedStderr(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const combined = carry + chunk;
      if (combined.length <= redactionWindow) {
        carry = combined;
        continue;
      }
      const flushUntil = combined.length - (redactionWindow - 1);
      const safeOutput = combined.slice(0, flushUntil);
      carry = combined.slice(flushUntil);
      if (safeOutput.length > 0) {
        process.stderr.write(redactSensitive(safeOutput));
      }
    }
    const trailing = carry + decoder.decode();
    if (trailing.length > 0) {
      process.stderr.write(redactSensitive(trailing));
    }
  } finally {
    reader.releaseLock();
  }
}

async function main() {
  await assertBroadcastReachable(broadcastUrl);

  const ffmpegArgs = buildFfmpegArgs(mode);
  const ffmpeg = Bun.spawn(["ffmpeg", ...ffmpegArgs], {
    stdin: "pipe",
    stdout: mode === "dryrun" ? "pipe" : "inherit",
    stderr: "pipe",
  });
  if (ffmpeg.stderr) {
    void pipeReadableToRedactedStderr(ffmpeg.stderr);
  }
  let ffmpegWritable = true;

  let ffplay: Bun.Subprocess | null = null;
  let ffplayPump: Promise<void> | null = null;
  if (mode === "dryrun") {
    ffplay = Bun.spawn(
      [
        "ffplay",
        "-hide_banner",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-framedrop",
        "-i",
        "pipe:0",
      ],
      {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const stdout = ffmpeg.stdout;
    if (!stdout || !ffplay.stdin) {
      throw new Error("Failed to pipe ffmpeg output into ffplay.");
    }
    if (typeof ffplay.stdin === "number") {
      throw new Error("ffplay stdin is not writable.");
    }
    ffplayPump = pipeReadableToSink(stdout, ffplay.stdin as SinkWriter);
  }

  let firstChunkResolve: (() => void) | null = null;
  let firstChunkReject: ((error: Error) => void) | null = null;
  const firstChunk = new Promise<void>((resolve, reject) => {
    firstChunkResolve = resolve;
    firstChunkReject = reject;
  });
  let shutdown: (() => Promise<void>) | null = null;

  const chunkServer = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/chunks" && server.upgrade(req)) {
        return;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(_ws, message) {
        if (!ffmpegWritable || !ffmpeg.stdin || typeof ffmpeg.stdin === "number") {
          return;
        }
        if (typeof message === "string") return;

        let chunk: Uint8Array | null = null;
        if (message instanceof ArrayBuffer) {
          chunk = new Uint8Array(message);
        } else if (ArrayBuffer.isView(message)) {
          chunk = new Uint8Array(
            message.buffer,
            message.byteOffset,
            message.byteLength,
          );
        }
        if (!chunk) return;

        try {
          ffmpeg.stdin.write(chunk);
          firstChunkResolve?.();
          firstChunkResolve = null;
          firstChunkReject = null;
        } catch (error) {
          ffmpegWritable = false;
          const detail = error instanceof Error ? error : new Error(String(error));
          firstChunkReject?.(detail);
          firstChunkResolve = null;
          firstChunkReject = null;
          void shutdown?.();
        }
      },
    },
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--allow-running-insecure-content",
      "--disable-features=LocalNetworkAccessChecks",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on("console", (msg) => {
    if (process.env.STREAM_DEBUG === "1") {
      console.log(`[broadcast] ${msg.type()}: ${redactSensitive(msg.text())}`);
    }
  });

  const captureUrl = new URL(broadcastUrl);
  captureUrl.searchParams.set("sink", `ws://127.0.0.1:${chunkServer.port}/chunks`);
  captureUrl.searchParams.set("captureFps", String(streamFps));
  captureUrl.searchParams.set("captureBitrate", String(captureBitrate));

  await page.goto(captureUrl.toString(), { waitUntil: "networkidle2" });
  await page.waitForSelector("#broadcast-canvas", { timeout: 10_000 });

  const firstChunkTimer = setTimeout(() => {
    firstChunkReject?.(
      new Error("No media chunks received from headless browser within 10s."),
    );
  }, 10_000);

  await firstChunk.finally(() => clearTimeout(firstChunkTimer));
  console.log(`Streaming broadcast in ${mode} mode`);

  let shuttingDown = false;
  shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ffmpegWritable = false;
    try {
      chunkServer.stop(true);
    } catch {}
    try {
      await browser.close();
    } catch {}
    try {
      ffmpeg.stdin?.end();
    } catch {}
    try {
      ffmpeg.kill();
    } catch {}
    if (ffplay) {
      try {
        if (ffplay.stdin && typeof ffplay.stdin !== "number") {
          ffplay.stdin.end();
        }
      } catch {}
      try {
        ffplay.kill();
      } catch {}
    }
  };

  const ffmpegExit = ffmpeg.exited.then((code) => {
    ffmpegWritable = false;
    void shutdown?.();
    return code;
  });

  process.on("SIGINT", () => {
    void shutdown?.();
  });
  process.on("SIGTERM", () => {
    void shutdown?.();
  });

  const exitCode = await ffmpegExit;
  if (ffplayPump) {
    await ffplayPump.catch(() => {
      // Ignore downstream pipe failures on shutdown.
    });
  }
  if (ffplay) {
    await ffplay.exited;
  }
  await shutdown?.();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(redactSensitive(detail));
  process.exit(1);
});
