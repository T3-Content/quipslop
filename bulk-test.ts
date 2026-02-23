import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MODELS,
  type Model,
  shuffle,
  withRetry,
  callGeneratePrompt,
  callGenerateAnswer,
  callVote,
  isRealString
} from "./game.ts";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: Set OPENROUTER_API_KEY environment variable");
  process.exit(1);
}

const TOTAL_ROUNDS = 1000;
const CONCURRENCY = 100;

const startTime = Date.now();
const LOGS_DIR = join(import.meta.dir, "logs");
mkdirSync(LOGS_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = join(LOGS_DIR, `bulk-test-${timestamp}.log`);

type RoundResult = {
  roundNum: number;
  prompter: Model;
  prompt: string;
  contA: Model;
  answerA: string;
  contB: Model;
  answerB: string;
  votes: { voter: Model, votedFor: "A" | "B" | null }[];
  votesA: number;
  votesB: number;
  winner: Model | null;
  error?: string;
};

const scores: Record<string, number> = Object.fromEntries(MODELS.map((m) => [m.name, 0]));
const results: RoundResult[] = [];
let completedRounds = 0;
let failedRounds = 0;
let currentTaskIndex = 0;

function updateProgress() {
  process.stdout.write(`\rProgress: ${completedRounds + failedRounds}/${TOTAL_ROUNDS} (Success: ${completedRounds}, Failed: ${failedRounds})`);
}

function logToBulkLog(message: string) {
  appendFileSync(LOG_FILE, message + "\n");
}

async function runRound(roundNum: number): Promise<RoundResult> {
  const shuffled = shuffle([...MODELS]);
  const prompter = shuffled[0]!;
  const contA = shuffled[1]!;
  const contB = shuffled[2]!;
  const voters = shuffled.slice(3);

  let prompt = "";
  try {
    prompt = await withRetry(
      () => callGeneratePrompt(prompter),
      (s) => isRealString(s, 10),
      3,
      `BulkR${roundNum}:prompt:${prompter.name}`
    );
  } catch (err: any) {
    return { roundNum, prompter, prompt: "", contA, answerA: "", contB, answerB: "", votes: [], votesA: 0, votesB: 0, winner: null, error: `Prompt failed: ${err.message}` };
  }

  let answerA = "", answerB = "";
  try {
    const [ansA, ansB] = await Promise.all([
      withRetry(() => callGenerateAnswer(contA, prompt), (s) => isRealString(s, 3), 3, `BulkR${roundNum}:answer:${contA.name}`),
      withRetry(() => callGenerateAnswer(contB, prompt), (s) => isRealString(s, 3), 3, `BulkR${roundNum}:answer:${contB.name}`)
    ]);
    answerA = ansA;
    answerB = ansB;
  } catch (err: any) {
    return { roundNum, prompter, prompt, contA, answerA: "", contB, answerB: "", votes: [], votesA: 0, votesB: 0, winner: null, error: `Answer failed: ${err.message}` };
  }

  let votesA = 0;
  let votesB = 0;
  const roundVotes: { voter: Model, votedFor: "A" | "B" | null }[] = [];
  
  await Promise.all(voters.map(async (voter) => {
    try {
      const showAFirst = Math.random() > 0.5;
      const first = showAFirst ? { answer: answerA } : { answer: answerB };
      const second = showAFirst ? { answer: answerB } : { answer: answerA };
      const vote = await withRetry(
        () => callVote(voter, prompt, first, second),
        (v) => v === "A" || v === "B",
        3,
        `BulkR${roundNum}:vote:${voter.name}`
      );
      
      const votedForA = showAFirst ? vote === "A" : vote === "B";
      if (votedForA) votesA++; else votesB++;
      roundVotes.push({ voter, votedFor: votedForA ? "A" : "B" });
    } catch (err) {
      roundVotes.push({ voter, votedFor: null });
    }
  }));

  let winner: Model | null = null;
  if (votesA > votesB) winner = contA;
  else if (votesB > votesA) winner = contB;

  return {
    roundNum,
    prompter,
    prompt,
    contA,
    answerA,
    contB,
    answerB,
    votes: roundVotes,
    votesA,
    votesB,
    winner
  };
}

async function worker() {
  while (true) {
    const roundNum = currentTaskIndex + 1;
    if (roundNum > TOTAL_ROUNDS) break;
    currentTaskIndex++;
    
    try {
      const result = await runRound(roundNum);
      if (result.error) {
        failedRounds++;
        logToBulkLog(`\n=== ROUND ${roundNum} FAILED ===\nError: ${result.error}\n`);
      } else {
        completedRounds++;
        if (result.winner) {
          scores[result.winner.name] = (scores[result.winner.name] ?? 0) + 1;
        }
        
        let roundLog = `\n=== ROUND ${roundNum} ===\n`;
        roundLog += `Prompter (${result.prompter.name}): ${result.prompt}\n`;
        roundLog += `Contestant A (${result.contA.name}): ${result.answerA} [Votes: ${result.votesA}]\n`;
        roundLog += `Contestant B (${result.contB.name}): ${result.answerB} [Votes: ${result.votesB}]\n`;
        
        roundLog += `\nVotes:\n`;
        for (const v of result.votes) {
          const votedName = v.votedFor === "A" ? result.contA.name : v.votedFor === "B" ? result.contB.name : "FAILED";
          roundLog += `  - ${v.voter.name} voted for: ${votedName}\n`;
        }
        
        roundLog += `\nWinner: ${result.winner ? result.winner.name : "TIE"}\n`;
        logToBulkLog(roundLog);
        results.push(result);
      }
    } catch (err) {
      failedRounds++;
      logToBulkLog(`\n=== ROUND ${roundNum} UNHANDLED ERROR ===\nError: ${err}\n`);
    }
    updateProgress();
  }
}

async function main() {
  console.log(`Starting bulk test of ${TOTAL_ROUNDS} rounds with concurrency ${CONCURRENCY}...`);
  console.log(`Readable log with outputs and votes will be saved to: ${LOG_FILE}\n`);
  
  logToBulkLog(`BULK TEST STARTED AT ${new Date().toISOString()}`);
  logToBulkLog(`Total Rounds: ${TOTAL_ROUNDS}, Concurrency: ${CONCURRENCY}\n`);

  updateProgress();
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  
  await Promise.all(workers);
  
  console.log(`\n\nBulk test complete! (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
  
  // Generate summary
  const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  
  let summary = `\n\n=== BULK TEST FINAL SUMMARY ===\n`;
  summary += `Total Rounds: ${TOTAL_ROUNDS}\n`;
  summary += `Completed: ${completedRounds}\n`;
  summary += `Failed: ${failedRounds}\n`;
  summary += `Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n\n`;
  
  summary += `=== FINAL RANKS ===\n`;
  sortedScores.forEach(([name, score], index) => {
    summary += `${index + 1}. ${name}: ${score} wins\n`;
  });
  
  logToBulkLog(summary);
  console.log(summary);
  console.log(`Readable log with outputs and votes saved to: ${LOG_FILE}`);
}

main().catch(console.error);
