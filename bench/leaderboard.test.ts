import { expect, test } from "bun:test";
import { buildLeaderboard } from "./leaderboard";

const model = (id: string, name: string) => ({ id, name });

test("leaderboard sorts by elo, then wins, then win rate, then name", () => {
  const rows = buildLeaderboard([
    { model: model("a", "Alpha"), elo: 1500, wins: 5, games: 10 },
    { model: model("b", "Beta"), elo: 1600, wins: 1, games: 1 },
    { model: model("c", "Charlie"), elo: 1500, wins: 6, games: 12 },
    { model: model("d", "Delta"), elo: 1500, wins: 6, games: 8 },
    { model: model("e", "Echo"), elo: 1500, wins: 6, games: 8 },
  ]);

  expect(rows.map((r) => r.modelName)).toEqual([
    "Beta",
    "Delta",
    "Echo",
    "Charlie",
    "Alpha",
  ]);
  expect(rows[0]?.rank).toBe(1);
  expect(rows[4]?.rank).toBe(5);
  expect(rows[1]?.winRate).toBe(75);
});
