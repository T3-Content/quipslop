import type { LeaderboardRow, RatingState } from "./types";

export function buildLeaderboard(rows: RatingState[]): LeaderboardRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (b.elo !== a.elo) return b.elo - a.elo;
    if (b.wins !== a.wins) return b.wins - a.wins;
    const wrA = a.games > 0 ? a.wins / a.games : 0;
    const wrB = b.games > 0 ? b.wins / b.games : 0;
    if (wrB !== wrA) return wrB - wrA;
    return a.model.name.localeCompare(b.model.name);
  });

  return sorted.map((entry, index) => ({
    rank: index + 1,
    modelId: entry.model.id,
    modelName: entry.model.name,
    elo: Number(entry.elo.toFixed(2)),
    wins: entry.wins,
    games: entry.games,
    winRate:
      entry.games > 0
        ? Number(((entry.wins / entry.games) * 100).toFixed(2))
        : 0,
  }));
}
