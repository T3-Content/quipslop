export type StreakStats = {
  current: number;
  best: number;
};

export type StreakMap = Record<string, StreakStats>;

type NamedContestant = { name: string };

export type RoundForStreaks = {
  contestants: [NamedContestant, NamedContestant];
  scoreA?: number;
  scoreB?: number;
};

export function createEmptyStreaks(modelNames: string[]): StreakMap {
  return Object.fromEntries(modelNames.map((name) => [name, { current: 0, best: 0 }]));
}

export function cloneStreaks(streaks: StreakMap): StreakMap {
  return Object.fromEntries(
    Object.entries(streaks).map(([name, stats]) => [name, { ...stats }]),
  );
}

function getOrCreate(streaks: StreakMap, name: string): StreakStats {
  if (!streaks[name]) {
    streaks[name] = { current: 0, best: 0 };
  }
  return streaks[name];
}

export function getRoundWinnerIndex(round: RoundForStreaks): 0 | 1 | null {
  if (round.scoreA === undefined || round.scoreB === undefined) {
    return null;
  }
  if (round.scoreA > round.scoreB) return 0;
  if (round.scoreB > round.scoreA) return 1;
  return null;
}

export function applyRoundToStreaks(streaks: StreakMap, round: RoundForStreaks): void {
  if (round.scoreA === undefined || round.scoreB === undefined) {
    return;
  }

  const contestantA = getOrCreate(streaks, round.contestants[0].name);
  const contestantB = getOrCreate(streaks, round.contestants[1].name);

  if (round.scoreA > round.scoreB) {
    contestantA.current += 1;
    contestantA.best = Math.max(contestantA.best, contestantA.current);
    contestantB.current = 0;
    return;
  }

  if (round.scoreB > round.scoreA) {
    contestantB.current += 1;
    contestantB.best = Math.max(contestantB.best, contestantB.current);
    contestantA.current = 0;
    return;
  }

  contestantA.current = 0;
  contestantB.current = 0;
}

export function computeStreaks(modelNames: string[], rounds: RoundForStreaks[]): StreakMap {
  const streaks = createEmptyStreaks(modelNames);
  for (const round of rounds) {
    applyRoundToStreaks(streaks, round);
  }
  return streaks;
}

export function streakMapsEqual(a: StreakMap, b: StreakMap): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    const left = a[name] ?? { current: 0, best: 0 };
    const right = b[name] ?? { current: 0, best: 0 };
    if (left.current !== right.current || left.best !== right.best) {
      return false;
    }
  }
  return true;
}
