export type BenchmarkScenarioName =
  | "messages"
  | "logs"
  | "memory"
  | "queue"
  | "attachment"
  | "images"
  | "soak";

export interface BenchmarkProfile {
  name: string;
  seed: number;
  messages: {
    hotMessageCount: number;
    activeConversations: number;
  };
  logs: {
    checkpoints: number[];
    queryIterations: number;
  };
  memory: {
    records: number;
    recallIterations: number;
  };
  queue: {
    backlog: number;
    sessions: number;
  };
  attachment: {
    characters: number;
    queryIterations: number;
    queryConcurrency: number;
  };
  images: {
    files: number;
    listIterations: number;
  };
  soak: {
    durationMs: number;
    tickIntervalMs: number;
    cacheLimit: number;
  };
  budgets?: BenchmarkBudgets;
}

export interface BenchmarkBudgets {
  messagesPersistP95Ms?: number;
  memoryRecallP95Ms?: number;
  queueEventLoopP99Ms?: number;
  imageListP95Ms?: number;
}

export interface LatencySummary {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface OperationMetrics {
  operations: number;
  wallTimeMs: number;
  throughputPerSecond: number;
  latencyMs: LatencySummary;
}

export interface EventLoopMetrics {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface ResourceMetrics {
  rssStartBytes: number;
  rssPeakBytes: number;
  rssEndBytes: number;
  rssDeltaBytes: number;
  heapUsedPeakBytes: number;
  gcPauseMs: LatencySummary;
}

export interface StorageMetrics {
  workspaceBytesBefore: number;
  workspaceBytesAfter: number;
  workspaceGrowthBytes: number;
  sqliteBytesAfter: number;
  walBytesAfter: number;
  peakWalBytes: number;
  freeDiskBytesBefore: number;
  freeDiskBytesAfter: number;
  freeDiskDeltaBytes: number;
}

export interface ScenarioOutcome {
  primaryPhase: string;
  phases: Record<string, OperationMetrics>;
  observations: Record<string, number | string | boolean>;
  checks: Record<string, boolean>;
}

export interface ScenarioReport extends ScenarioOutcome {
  name: BenchmarkScenarioName;
  workload: Record<string, number | number[]>;
  elapsedMs: number;
  eventLoop: EventLoopMetrics;
  resources: ResourceMetrics;
  storage: StorageMetrics;
}

export interface BenchmarkEnvironment {
  node: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  suite: "sunabot-capacity-baseline";
  profile: string;
  seed: number;
  startedAt: string;
  finishedAt: string;
  environment: BenchmarkEnvironment;
  scenarios: ScenarioReport[];
  status: "passed" | "failed";
  failures: string[];
  comparison?: BenchmarkComparison;
}

export interface BenchmarkComparison {
  baselineProfile: string;
  maxRegressionPercent: number;
  regressions: string[];
}

export interface RunBenchmarkOptions {
  profile: BenchmarkProfile;
  scenarios?: BenchmarkScenarioName[];
  outputPath?: string;
  baselineReport?: BenchmarkReport;
  maxRegressionPercent?: number;
  keepWorkspace?: boolean;
}
