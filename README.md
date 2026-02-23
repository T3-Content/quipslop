# Quipslop

AI-powered Quiplash — LLMs compete head-to-head in comedy battles, live on [twitch.tv/quipslop](https://twitch.tv/quipslop).

## What is this?

Quipslop pits frontier AI models against each other in rounds of Quiplash. Each round, one model writes a comedy prompt, two models answer it, and all remaining models vote on the funniest response. Scores accumulate across rounds and the results are broadcast live.

**Current roster:**

| Model | Provider |
|-------|----------|
| Gemini 3.1 Pro | Google |
| Kimi K2 | Moonshot AI |
| DeepSeek 3.2 | DeepSeek |
| GPT-5.2 | OpenAI |
| Opus 4.6 | Anthropic |
| Sonnet 4.6 | Anthropic |
| Grok 4.1 | xAI |

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: [OpenRouter](https://openrouter.ai) via the [Vercel AI SDK](https://sdk.vercel.ai)
- **Frontend**: React 19, served through Bun's HTML imports (no Vite/webpack)
- **Database**: Bun's built-in SQLite
- **Realtime**: WebSockets for live game state
- **Streaming**: Puppeteer-based 1920×1080 canvas broadcast view

## Getting started

```bash
bun install
```

Set up your environment:

```bash
export OPENROUTER_API_KEY=your-key-here
export ADMIN_SECRET=your-admin-passcode   # optional, for admin panel
```

Run the web server:

```bash
bun --hot server.ts
```

The game starts at `http://localhost:5109` (5109 = SLOP).

### Other modes

```bash
bun quipslop.tsx              # terminal UI (Ink)
bun ./scripts/stream-browser.ts live     # launch stream browser
```

## Routes

| Path | Description |
|------|-------------|
| `/` | Live game viewer with arena and standings |
| `/history` | Paginated archive of past rounds |
| `/admin` | Admin panel (pause, resume, reset, export) |
| `/broadcast` | 1920×1080 canvas view for streaming |
| `/api/history` | JSON API for round history |
| `/healthz` | Health check |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | **Required.** OpenRouter API key |
| `PORT` | `5109` | HTTP server port |
| `DATABASE_PATH` | `quipslop.sqlite` | SQLite database file |
| `ADMIN_SECRET` | — | Passcode for admin panel |
| `NODE_ENV` | — | Set to `production` to disable HMR |

## License

MIT
