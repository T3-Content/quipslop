import type { BenchModel } from "./types";

// Quipbench source-of-truth model roster.
export const QUIPBENCH_MODELS: BenchModel[] = [
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
  { id: "moonshotai/kimi-k2", name: "Kimi K2" },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek 3.2" },
  { id: "openai/gpt-5.2", name: "GPT-5.2" },
  { id: "anthropic/claude-opus-4.6", name: "Opus 4.6" },
  { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
  { id: "x-ai/grok-4.1-fast", name: "Grok 4.1" },
];
