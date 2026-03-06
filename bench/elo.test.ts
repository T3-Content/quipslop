import { expect, test } from "bun:test";
import { expectedScore, updatePairElo } from "./elo";

test("expected score is symmetric", () => {
  const a = expectedScore(1600, 1500);
  const b = expectedScore(1500, 1600);
  expect(Number((a + b).toFixed(8))).toBe(1);
  expect(a).toBeGreaterThan(0.5);
});

test("winner gains rating and loser drops", () => {
  const { nextA, nextB } = updatePairElo(1500, 1500, 1, 24);
  expect(nextA).toBeGreaterThan(1500);
  expect(nextB).toBeLessThan(1500);
});

test("tie moves ratings toward each other", () => {
  const { nextA, nextB } = updatePairElo(1700, 1500, 0.5, 24);
  expect(nextA).toBeLessThan(1700);
  expect(nextB).toBeGreaterThan(1500);
});
