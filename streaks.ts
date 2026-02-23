export type StreakStats = {
  current: number;
};

export type StreakMap = Record<string, StreakStats>;

type NamedContestant = { name: string };

export type RoundForStreaks = {
  contestants: [NamedContestant, NamedContestant];
  scoreA?: number;
  scoreB?: number;
};

export function createEmptyStreaks(modelNames: string[]): StreakMap {
  const streaks = Object.create(null) as StreakMap;
  for (const name of modelNames) {
    streaks[name] = { current: 0 };
  }
  return streaks;
}

function getOrCreate(streaks: StreakMap, name: string): StreakStats {
  const existing = streaks[name];
  if (existing) {
    return existing;
  }
  const created = { current: 0 };
  streaks[name] = created;
  return created;
}

export function applyRoundToStreaks(streaks: StreakMap, round: RoundForStreaks): void {
  if (round.scoreA === undefined || round.scoreB === undefined) {
    return;
  }

  const contestantA = getOrCreate(streaks, round.contestants[0].name);
  const contestantB = getOrCreate(streaks, round.contestants[1].name);

  if (round.scoreA > round.scoreB) {
    contestantA.current += 1;
    contestantB.current = 0;
    return;
  }

  if (round.scoreB > round.scoreA) {
    contestantB.current += 1;
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
