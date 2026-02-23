export type BenchModel = {
  id: string;
  name: string;
};

export type VoteRecord = {
  voterId: string;
  voterName: string;
  votedFor: "A" | "B" | null;
  showAFirst: boolean;
  error?: string;
};

export type MatchRecord = {
  runId: string;
  roundNum: number;
  prompter: BenchModel;
  contestantA: BenchModel;
  contestantB: BenchModel;
  prompt?: string;
  answerA?: string;
  answerB?: string;
  votesA: number;
  votesB: number;
  winner: "A" | "B" | "TIE" | "ERROR";
  votes: VoteRecord[];
  error?: string;
};

export type RatingState = {
  model: BenchModel;
  elo: number;
  wins: number;
  games: number;
};

export type LeaderboardRow = {
  rank: number;
  modelId: string;
  modelName: string;
  elo: number;
  wins: number;
  games: number;
  winRate: number;
};

export type RunMeta = {
  runId: string;
  startedAt: string;
  endedAt: string;
  roundsRequested: number;
  roundsCompleted: number;
  failures: number;
  concurrency: number;
  eloK: number;
  initialElo: number;
  seed: number;
};

export type QuipbenchSnapshot = {
  runMeta: RunMeta;
  leaderboard: LeaderboardRow[];
  chart: Array<{
    modelName: string;
    elo: number;
  }>;
};

export type QuipbenchRunResult = {
  runMeta: RunMeta;
  leaderboard: LeaderboardRow[];
  snapshotPathJson: string;
  snapshotPathJs: string;
};

export type QuipbenchAi = {
  generatePrompt: (model: BenchModel) => Promise<string>;
  generateAnswer: (model: BenchModel, prompt: string) => Promise<string>;
  vote: (
    voter: BenchModel,
    prompt: string,
    answerA: string,
    answerB: string,
  ) => Promise<"A" | "B">;
};
