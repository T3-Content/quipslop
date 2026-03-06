# Quipbench

Standalone benchmark runner + static dashboard for Quipslop models.

## What it does

- Runs live OpenRouter self-play rounds (same mechanics as the main game)
- Computes Elo-first leaderboard with wins/games/win-rate
- Stores run + match + rating records in `bench/quipbench.sqlite`
- Exports latest snapshot to `bench/out/latest.json` and `bench/out/latest.js`
- Renders a standalone dashboard at `bench/dashboard/index.html`

## Prerequisites

- Bun
- `OPENROUTER_API_KEY` set in environment for live runs

## Commands

From repo root:

- `bun run quipbench:run`
- `bun run quipbench:export`
- `bun run quipbench:open`

### Run options

`quipbench:run` supports CLI flags:

- `--rounds=100`
- `--concurrency=4`
- `--k=24`
- `--initialElo=1500`
- `--seed=12345`
- `--out=bench/out`
- `--db=bench/quipbench.sqlite`

Example:

```bash
bun bench/run.ts --rounds=150 --concurrency=6 --seed=42
```

## Output contract (`latest` snapshot)

`bench/out/latest.json` and `bench/out/latest.js` contain:

- `runMeta`: `runId`, `startedAt`, `endedAt`, `roundsRequested`, `roundsCompleted`, `failures`, `concurrency`, `eloK`, `initialElo`, `seed`
- `leaderboard[]`: `rank`, `modelId`, `modelName`, `elo`, `wins`, `games`, `winRate`
- `chart[]`: `{ modelName, elo }`

## Dashboard

Open `bench/dashboard/index.html` directly or via:

```bash
bun run quipbench:open
```

The dashboard reads `../out/latest.js` and shows:

- run metadata summary
- vertical Elo bar chart with model names under each bar
- leaderboard table
