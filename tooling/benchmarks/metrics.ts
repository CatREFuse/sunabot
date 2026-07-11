import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver
} from "node:perf_hooks";
import type {
  EventLoopMetrics,
  LatencySummary,
  OperationMetrics,
  ResourceMetrics,
  ScenarioOutcome,
  ScenarioReport,
  StorageMetrics
} from "./types.js";

const NS_PER_MS = 1_000_000;

export class OperationRecorder {
  private readonly startedAt = performance.now();
  private readonly latencies: number[] = [];
  private operations = 0;

  measure<T>(operation: () => T, operationCount = 1): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.add(performance.now() - startedAt, operationCount);
    }
  }

  async measureAsync<T>(operation: () => Promise<T>, operationCount = 1): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.add(performance.now() - startedAt, operationCount);
    }
  }

  add(durationMs: number, operationCount = 1) {
    this.latencies.push(durationMs);
    this.operations += operationCount;
  }

  finish(): OperationMetrics {
    const wallTimeMs = Math.max(0.001, performance.now() - this.startedAt);
    return {
      operations: this.operations,
      wallTimeMs: rounded(wallTimeMs),
      throughputPerSecond: rounded((this.operations * 1_000) / wallTimeMs),
      latencyMs: summarizeLatencies(this.latencies)
    };
  }
}

export interface BenchmarkSampler {
  sample(): void;
  sampleDatabase(databasePath: string): void;
}

export async function measuredScenario(
  name: ScenarioReport["name"],
  root: string,
  workload: ScenarioReport["workload"],
  operation: (sampler: BenchmarkSampler) => Promise<ScenarioOutcome>
): Promise<ScenarioReport> {
  const storageBefore = await storageSnapshot(root);
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const resources = new ResourceSampler();
  eventLoop.enable();
  await pause(15);
  const startedAt = performance.now();
  try {
    const outcome = await operation(resources);
    await new Promise<void>((resolve) => setImmediate(resolve));
    resources.sample();
    const storageAfter = await storageSnapshot(root);
    return {
      name,
      workload,
      elapsedMs: rounded(performance.now() - startedAt),
      eventLoop: eventLoopMetrics(eventLoop),
      resources: await resources.finish(),
      storage: storageMetrics(storageBefore, storageAfter, resources.peakWalBytes),
      ...outcome
    };
  } finally {
    eventLoop.disable();
    resources.disconnect();
  }
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (!values.length) {
    return { samples: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    samples: sorted.length,
    min: rounded(sorted[0] ?? 0),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
    max: rounded(sorted.at(-1) ?? 0),
    mean: rounded(sum / sorted.length)
  };
}

export function percentile(sortedValues: readonly number[], quantile: number) {
  if (!sortedValues.length) return 0;
  const bounded = Math.max(0, Math.min(1, quantile));
  const index = Math.max(0, Math.ceil(bounded * sortedValues.length) - 1);
  return sortedValues[index] ?? 0;
}

interface StorageSnapshot {
  workspaceBytes: number;
  sqliteBytes: number;
  walBytes: number;
  freeDiskBytes: number;
}

class ResourceSampler implements BenchmarkSampler {
  private readonly rssStartBytes: number;
  private rssPeakBytes: number;
  private heapUsedPeakBytes: number;
  private readonly gcPauses: number[] = [];
  private readonly observer: PerformanceObserver;
  peakWalBytes = 0;

  constructor() {
    const usage = process.memoryUsage();
    this.rssStartBytes = usage.rss;
    this.rssPeakBytes = usage.rss;
    this.heapUsedPeakBytes = usage.heapUsed;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) this.gcPauses.push(entry.duration);
    });
    this.observer.observe({ entryTypes: ["gc"] });
  }

  sample() {
    const usage = process.memoryUsage();
    this.rssPeakBytes = Math.max(this.rssPeakBytes, usage.rss);
    this.heapUsedPeakBytes = Math.max(this.heapUsedPeakBytes, usage.heapUsed);
  }

  sampleDatabase(databasePath: string) {
    this.sample();
    this.peakWalBytes = Math.max(this.peakWalBytes, fileSize(`${databasePath}-wal`));
  }

  async finish(): Promise<ResourceMetrics> {
    if (typeof global.gc === "function") global.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sample();
    const rssEndBytes = process.memoryUsage().rss;
    return {
      rssStartBytes: this.rssStartBytes,
      rssPeakBytes: this.rssPeakBytes,
      rssEndBytes,
      rssDeltaBytes: rssEndBytes - this.rssStartBytes,
      heapUsedPeakBytes: this.heapUsedPeakBytes,
      gcPauseMs: summarizeLatencies(this.gcPauses)
    };
  }

  disconnect() {
    this.observer.disconnect();
  }
}

async function storageSnapshot(root: string): Promise<StorageSnapshot> {
  let workspaceBytes = 0;
  let sqliteBytes = 0;
  let walBytes = 0;
  for (const file of await listFiles(root)) {
    const stats = await fsp.stat(file);
    workspaceBytes += stats.size;
    if (file.endsWith(".sqlite")) sqliteBytes += stats.size;
    if (file.endsWith(".sqlite-wal")) walBytes += stats.size;
  }
  const stats = await fsp.statfs(root, { bigint: true });
  return {
    workspaceBytes,
    sqliteBytes,
    walBytes,
    freeDiskBytes: safeNumber(stats.bavail * stats.bsize)
  };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function storageMetrics(before: StorageSnapshot, after: StorageSnapshot, peakWalBytes: number): StorageMetrics {
  return {
    workspaceBytesBefore: before.workspaceBytes,
    workspaceBytesAfter: after.workspaceBytes,
    workspaceGrowthBytes: after.workspaceBytes - before.workspaceBytes,
    sqliteBytesAfter: after.sqliteBytes,
    walBytesAfter: after.walBytes,
    peakWalBytes: Math.max(peakWalBytes, after.walBytes),
    freeDiskBytesBefore: before.freeDiskBytes,
    freeDiskBytesAfter: after.freeDiskBytes,
    freeDiskDeltaBytes: after.freeDiskBytes - before.freeDiskBytes
  };
}

function eventLoopMetrics(histogram: ReturnType<typeof monitorEventLoopDelay>): EventLoopMetrics {
  const milliseconds = (value: number) => finite(value / NS_PER_MS);
  return {
    minMs: rounded(milliseconds(histogram.min)),
    p50Ms: rounded(milliseconds(histogram.percentile(50))),
    p95Ms: rounded(milliseconds(histogram.percentile(95))),
    p99Ms: rounded(milliseconds(histogram.percentile(99))),
    maxMs: rounded(milliseconds(histogram.max)),
    meanMs: rounded(milliseconds(histogram.mean))
  };
}

function fileSize(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function finite(value: number) {
  return Number.isFinite(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : 0;
}

function rounded(value: number) {
  return Number(finite(value).toFixed(3));
}

function safeNumber(value: bigint) {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function pause(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
