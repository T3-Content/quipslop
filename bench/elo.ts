export function expectedScore(playerElo: number, opponentElo: number): number {
  return 1 / (1 + 10 ** ((opponentElo - playerElo) / 400));
}

export function nextElo(
  playerElo: number,
  opponentElo: number,
  actualScore: number,
  k: number,
): number {
  const exp = expectedScore(playerElo, opponentElo);
  return playerElo + k * (actualScore - exp);
}

export function updatePairElo(
  eloA: number,
  eloB: number,
  actualA: number,
  k: number,
): { nextA: number; nextB: number } {
  const actualB = 1 - actualA;
  return {
    nextA: nextElo(eloA, eloB, actualA, k),
    nextB: nextElo(eloB, eloA, actualB, k),
  };
}
