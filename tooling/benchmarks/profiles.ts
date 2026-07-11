import type { BenchmarkProfile } from "./types.js";

const HOUR_MS = 60 * 60 * 1_000;

export const benchmarkProfiles: Readonly<Record<string, BenchmarkProfile>> = {
  ci: {
    name: "ci",
    seed: 20_260_711,
    messages: { hotMessageCount: 100, activeConversations: 8 },
    logs: { checkpoints: [1_000], queryIterations: 5 },
    memory: { records: 1_000, recallIterations: 5 },
    queue: { backlog: 1_000, sessions: 16 },
    attachment: { characters: 200_000, queryIterations: 3, queryConcurrency: 2 },
    images: { files: 250, listIterations: 5 },
    soak: { durationMs: 1_000, tickIntervalMs: 100, cacheLimit: 128 }
  },
  capacity: {
    name: "capacity",
    seed: 20_260_711,
    messages: { hotMessageCount: 2_000, activeConversations: 80 },
    logs: { checkpoints: [100_000, 1_000_000], queryIterations: 20 },
    memory: { records: 100_000, recallIterations: 20 },
    queue: { backlog: 100_000, sessions: 80 },
    attachment: { characters: 20_000_000, queryIterations: 8, queryConcurrency: 4 },
    images: { files: 10_000, listIterations: 20 },
    soak: { durationMs: 5_000, tickIntervalMs: 250, cacheLimit: 2_000 },
    budgets: {
      messagesPersistP95Ms: 20,
      memoryRecallP95Ms: 200,
      queueEventLoopP99Ms: 50,
      imageListP95Ms: 200
    }
  },
  full: {
    name: "full",
    seed: 20_260_711,
    messages: { hotMessageCount: 2_000, activeConversations: 80 },
    logs: { checkpoints: [100_000, 1_000_000], queryIterations: 50 },
    memory: { records: 100_000, recallIterations: 30 },
    queue: { backlog: 100_000, sessions: 80 },
    attachment: { characters: 20_000_000, queryIterations: 12, queryConcurrency: 4 },
    images: { files: 10_000, listIterations: 30 },
    soak: { durationMs: 72 * HOUR_MS, tickIntervalMs: 1_000, cacheLimit: 2_000 },
    budgets: {
      messagesPersistP95Ms: 20,
      memoryRecallP95Ms: 200,
      queueEventLoopP99Ms: 50,
      imageListP95Ms: 200
    }
  }
};

export const testBenchmarkProfile: BenchmarkProfile = {
  name: "test",
  seed: 7,
  messages: { hotMessageCount: 4, activeConversations: 2 },
  logs: { checkpoints: [12], queryIterations: 2 },
  memory: { records: 20, recallIterations: 2 },
  queue: { backlog: 12, sessions: 3 },
  attachment: { characters: 20_000, queryIterations: 2, queryConcurrency: 1 },
  images: { files: 8, listIterations: 2 },
  soak: { durationMs: 40, tickIntervalMs: 10, cacheLimit: 3 }
};

export function benchmarkProfile(name: string) {
  const profile = benchmarkProfiles[name];
  if (!profile) {
    throw new Error(`Unknown benchmark profile \"${name}\". Expected one of: ${Object.keys(benchmarkProfiles).join(", ")}.`);
  }
  return profile;
}
