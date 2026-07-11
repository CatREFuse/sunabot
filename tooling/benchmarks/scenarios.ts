import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import { bm25Search } from "../../services/memory/recall/recallService.js";
import type { MemoryEntry } from "../../services/memory/types.js";
import {
  readChunksSqlite,
  SqliteChunkWriter,
  StreamingTextChunker
} from "../../services/media/attachments/chunks.js";
import { rankAttachmentChunks } from "../../services/media/attachments/context.js";
import type { ConversationRecord, ImageHistoryRecord } from "../../src/types.js";
import { measuredScenario, OperationRecorder, type BenchmarkSampler } from "./metrics.js";
import type { BenchmarkProfile, ScenarioReport } from "./types.js";

const BASE_TIME = Date.UTC(2026, 6, 11, 0, 0, 0);
const IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export async function runMessagesScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.messages;
  return measuredScenario("messages", root, { ...config }, async (sampler) => {
    const databasePath = path.join(root, "business", "data", "sunabot.sqlite");
    const store = new ApplicationDataStore(databasePath);
    const records = Array.from({ length: config.activeConversations }, (_, index) => conversation(index));
    const hot = records[0];
    if (!hot) throw new Error("Message benchmark requires at least one conversation.");
    const recorder = new OperationRecorder();
    try {
      store.replaceConversations(records);
      for (let index = 0; index < config.hotMessageCount; index += 1) {
        const at = benchmarkIso(index);
        hot.messages.push({
          id: `message-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          text: `deterministic benchmark message ${index} ${"x".repeat(48)}`,
          at,
          sequence: index + 1,
          userId: 10_000 + (index % config.activeConversations)
        });
        hot.messageCount = hot.messages.length;
        hot.lastAt = at;
        hot.lastText = hot.messages.at(-1)?.text ?? "";
        recorder.measure(() => store.replaceConversations(records));
        if (shouldSample(index, config.hotMessageCount)) sampler.sampleDatabase(databasePath);
      }
      const persisted = store.readConversations();
      const persistedHot = persisted.find((record) => record.id === hot.id);
      sampler.sampleDatabase(databasePath);
      return {
        primaryPhase: "persist",
        phases: { persist: recorder.finish() },
        observations: {
          activeConversations: persisted.length,
          hotConversationMessages: persistedHot?.messages.length ?? 0
        },
        checks: {
          conversationCountMatches: persisted.length === config.activeConversations,
          activeConversationsSeeded: persisted.every((record) => record.messages.length > 0),
          hotMessageCountMatches: persistedHot?.messages.length === config.hotMessageCount
        }
      };
    } finally {
      store.close();
    }
  });
}

export async function runLogsScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.logs;
  return measuredScenario("logs", root, { checkpoints: config.checkpoints, queryIterations: config.queryIterations }, async (sampler) => {
    const databasePath = path.join(root, "business", "data", "sunabot.sqlite");
    const store = new ApplicationDataStore(databasePath);
    const append = new OperationRecorder();
    const phases: Record<string, ReturnType<OperationRecorder["finish"]>> = {};
    let lastResults = 0;
    const checkpoints = [...config.checkpoints].sort((left, right) => left - right);
    const maximum = checkpoints.at(-1) ?? 0;
    try {
      for (let index = 1; index <= maximum; index += 1) {
        append.measure(() => store.appendRequestLog({
          id: `log-${index}`,
          at: benchmarkIso(index),
          category: "benchmark",
          action: `request.${index % 5}`,
          metadata: {
            marker: index === 1 ? "needle-42" : `needle-${index % 97}`,
            payload: `deterministic log payload ${index}`
          }
        }));
        if (shouldSample(index, maximum)) sampler.sampleDatabase(databasePath);
        if (checkpoints.includes(index)) {
          const query = new OperationRecorder();
          for (let iteration = 0; iteration < config.queryIterations; iteration += 1) {
            lastResults = query.measure(() => store.readRequestLogs({ query: "needle-42", limit: 20 })).length;
          }
          phases[`query@${index}`] = query.finish();
        }
      }
      phases.append = append.finish();
      const count = store.counts().requestLogs;
      sampler.sampleDatabase(databasePath);
      const primaryPhase = `query@${maximum}`;
      return {
        primaryPhase,
        phases,
        observations: { records: count, queryMatches: lastResults, checkpoints: checkpoints.length },
        checks: {
          recordCountMatches: count === maximum,
          queryReturnedMatches: lastResults > 0,
          finalCheckpointMeasured: Boolean(phases[primaryPhase])
        }
      };
    } finally {
      store.close();
    }
  });
}

export async function runMemoryScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.memory;
  return measuredScenario("memory", root, { ...config }, async (sampler) => {
    const databasePath = path.join(root, "business", "data", "sunabot.sqlite");
    const store = new ApplicationDataStore(databasePath);
    const entries = Array.from({ length: config.records }, (_, index) => memoryEntry(index));
    const records = entries.map((entry) => ({ ...entry }));
    const load = new OperationRecorder();
    const recall = new OperationRecorder();
    let lastMatches = 0;
    try {
      load.measure(() => store.replaceMemory("long_term", records), entries.length);
      const loadMetrics = load.finish();
      sampler.sampleDatabase(databasePath);
      for (let iteration = 0; iteration < config.recallIterations; iteration += 1) {
        const term = `token${(iteration * 17) % 97}`;
        lastMatches = recall.measure(() => bm25Search(`benchmark project ${term}`, entries, 8)).length;
        sampler.sample();
      }
      const count = store.counts().longTermMemory;
      return {
        primaryPhase: "recall",
        phases: { load: loadMetrics, recall: recall.finish() },
        observations: { records: count, recallMatches: lastMatches },
        checks: {
          recordCountMatches: count === config.records,
          recallReturnedMatches: lastMatches > 0
        }
      };
    } finally {
      store.close();
    }
  });
}

export async function runQueueScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.queue;
  return measuredScenario("queue", root, { ...config }, async (sampler) => {
    const databasePath = path.join(root, "business", "data", "session-queue.sqlite");
    let now = BASE_TIME;
    let nextId = 0;
    const store = new SessionStore({
      databasePath,
      clock: () => now,
      idFactory: () => `benchmark-${++nextId}`
    });
    const enqueue = new OperationRecorder();
    try {
      for (let index = 0; index < config.backlog; index += 1) {
        now = BASE_TIME + index;
        enqueue.measure(() => store.enqueueEvent({
          sessionId: `group:${index % config.sessions}`,
          kind: "benchmark.incoming",
          dedupeKey: `benchmark:${index}`,
          payload: { schemaVersion: 1, messageId: index, text: `queued ${index}` }
        }));
        if (shouldSample(index, config.backlog)) sampler.sampleDatabase(databasePath);
      }
      sampler.sampleDatabase(databasePath);
    } finally {
      store.close();
    }

    const observedAt = now + 1_000;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare(`
        SELECT COUNT(*) AS backlog, MIN(created_at) AS oldest_at,
               COUNT(DISTINCT session_id) AS sessions
        FROM session_events WHERE status = 'pending'
      `).get() as Record<string, number | null>;
      const backlog = Number(row.backlog ?? 0);
      const oldestAt = Number(row.oldest_at ?? observedAt);
      const sessions = Number(row.sessions ?? 0);
      return {
        primaryPhase: "enqueue",
        phases: { enqueue: enqueue.finish() },
        observations: {
          backlog,
          sessions,
          backlogOldestAgeMs: Math.max(0, observedAt - oldestAt)
        },
        checks: {
          backlogCountMatches: backlog === config.backlog,
          sessionCountMatches: sessions === Math.min(config.sessions, config.backlog),
          oldestAgeObserved: backlog === 0 || observedAt - oldestAt >= 1_000
        }
      };
    } finally {
      database.close();
    }
  });
}

export async function runAttachmentScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.attachment;
  return measuredScenario("attachment", root, { ...config }, async (sampler) => {
    const databasePath = path.join(root, "cache", "attachments", "benchmark", "chunks.sqlite");
    const writer = await SqliteChunkWriter.open(databasePath);
    const chunker = new StreamingTextChunker();
    const index = new OperationRecorder();
    const block = attachmentBlock(64 * 1_024);
    let remaining = config.characters;
    let chunksWritten = 0;
    try {
      while (remaining > 0) {
        const value = block.slice(0, Math.min(block.length, remaining));
        remaining -= value.length;
        for (const chunk of chunker.push(value)) {
          await index.measureAsync(() => writer.write(chunk), chunk.text.length);
          chunksWritten += 1;
        }
        sampler.sample();
      }
      for (const chunk of chunker.end()) {
        await index.measureAsync(() => writer.write(chunk), chunk.text.length);
        chunksWritten += 1;
      }
      await writer.commit();
    } catch (error) {
      await writer.abort();
      throw error;
    }

    const indexMetrics = index.finish();
    sampler.sampleDatabase(databasePath);
    const query = new OperationRecorder();
    let rankedChunks = 0;
    for (let offset = 0; offset < config.queryIterations; offset += config.queryConcurrency) {
      const batchSize = Math.min(config.queryConcurrency, config.queryIterations - offset);
      await Promise.all(Array.from({ length: batchSize }, async () => {
        rankedChunks = query.measure(() => {
          const chunks = readChunksSqlite(databasePath);
          return rankAttachmentChunks([{
            attachmentId: "benchmark",
            name: "benchmark.txt",
            chunks
          }], "needle42").length;
        });
      }));
      sampler.sample();
    }
    return {
      primaryPhase: "query",
      phases: { index: indexMetrics, query: query.finish() },
      observations: { characters: config.characters, chunks: chunksWritten, rankedChunks },
      checks: {
        indexedCharacters: indexMetrics.operations >= config.characters,
        chunksPersisted: rankedChunks === chunksWritten,
        queryReturnedMatches: rankedChunks > 0
      }
    };
  });
}

export async function runImagesScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.images;
  return measuredScenario("images", root, { ...config }, async (sampler) => {
    const databasePath = path.join(root, "business", "data", "sunabot.sqlite");
    const imageDir = path.join(root, "business", "media", "images");
    await fsp.mkdir(imageDir, { recursive: true });
    const create = new OperationRecorder();
    const records: ImageHistoryRecord[] = [];
    for (let index = 0; index < config.files; index += 1) {
      const fileName = `benchmark-${String(index).padStart(6, "0")}.png`;
      const filePath = path.join(imageDir, fileName);
      await create.measureAsync(() => fsp.writeFile(filePath, IMAGE_BYTES));
      records.push({
        id: fileName,
        url: `/generated-images/${fileName}`,
        filePath,
        createdAt: benchmarkIso(index)
      });
      if (shouldSample(index, config.files)) sampler.sample();
    }

    const createMetrics = create.finish();
    const store = new ApplicationDataStore(databasePath);
    const index = new OperationRecorder();
    const list = new OperationRecorder();
    let listed = 0;
    try {
      index.measure(() => store.replaceImageHistory(records.slice(-80)), Math.min(80, records.length));
      const indexMetrics = index.finish();
      sampler.sampleDatabase(databasePath);
      for (let iteration = 0; iteration < config.listIterations; iteration += 1) {
        listed = list.measure(() => scanImages(imageDir, store.readImageHistory())).length;
        sampler.sample();
      }
      return {
        primaryPhase: "list",
        phases: { create: createMetrics, index: indexMetrics, list: list.finish() },
        observations: { files: config.files, listed },
        checks: {
          fileCountMatches: fs.readdirSync(imageDir).length === config.files,
          listLimitApplied: listed === Math.min(80, config.files)
        }
      };
    } finally {
      store.close();
    }
  });
}

export async function runSoakScenario(root: string, profile: BenchmarkProfile): Promise<ScenarioReport> {
  const config = profile.soak;
  return measuredScenario("soak", root, { ...config }, async (sampler) => {
    const databasePath = path.join(root, "business", "data", "sunabot.sqlite");
    const store = new ApplicationDataStore(databasePath);
    const cache = new Map<string, number>();
    const samples: Array<{ at: number; rss: number }> = [];
    const ticks = new OperationRecorder();
    const startedAt = performance.now();
    const deadline = startedAt + config.durationMs;
    let sequence = 0;
    let evictions = 0;
    try {
      while (performance.now() < deadline) {
        const remaining = deadline - performance.now();
        await pause(Math.min(config.tickIntervalMs, Math.max(0, remaining)));
        if (performance.now() > deadline + config.tickIntervalMs) break;
        ticks.measure(() => {
          const key = `sender:${sequence}`;
          cache.set(key, performance.now());
          if (cache.size > config.cacheLimit) {
            const oldest = cache.keys().next().value as string | undefined;
            if (oldest) {
              cache.delete(oldest);
              evictions += 1;
            }
          }
          store.appendRequestLog({
            id: `soak-${sequence}`,
            at: benchmarkIso(sequence),
            category: "benchmark.soak",
            action: "tick",
            metadata: { sequence }
          });
          sequence += 1;
        });
        const now = performance.now();
        samples.push({ at: now - startedAt, rss: process.memoryUsage().rss });
        sampler.sampleDatabase(databasePath);
      }
      const now = performance.now();
      const oldest = cache.values().next().value as number | undefined;
      const logs = store.counts().requestLogs;
      return {
        primaryPhase: "tick",
        phases: { tick: ticks.finish() },
        observations: {
          durationMs: Math.round(now - startedAt),
          ticks: sequence,
          cacheSize: cache.size,
          cacheEvictions: evictions,
          cacheOldestAgeMs: oldest === undefined ? 0 : Math.max(0, now - oldest),
          rssSlopeBytesPerHour: rssSlopeBytesPerHour(samples)
        },
        checks: {
          durationReached: now - startedAt >= config.durationMs * 0.9,
          cacheBounded: cache.size <= config.cacheLimit,
          writesPersisted: logs === sequence
        }
      };
    } finally {
      store.close();
    }
  });
}

function conversation(index: number): ConversationRecord {
  const at = benchmarkIso(index);
  const messages = index === 0 ? [] : [{
    id: `seed-${index}`,
    role: "user" as const,
    text: `concurrent conversation seed ${index}`,
    at,
    sequence: 1,
    userId: 10_000 + index
  }];
  return {
    id: `private:${10_000 + index}`,
    scope: "private",
    title: `Benchmark ${index}`,
    userId: 10_000 + index,
    messageCount: messages.length,
    lastAt: at,
    lastText: messages.at(-1)?.text ?? "",
    messages
  };
}

function memoryEntry(index: number): MemoryEntry {
  const id = `memory-${index}`;
  const text = `benchmark project token${index % 97} deterministic memory fact ${index}`;
  return {
    id,
    source: "long_term",
    sourceTitle: "Long-term memory",
    fileName: "LONG_TERM_MEMORY.jsonl",
    editable: true,
    key: id,
    value: text,
    text,
    field: "fact",
    userId: String(10_000 + (index % 80)),
    createdAt: benchmarkIso(index)
  };
}

function scanImages(directory: string, records: ImageHistoryRecord[]) {
  const byUrl = new Map(records.map((record) => [record.url, record]));
  for (const fileName of fs.readdirSync(directory)) {
    if (!/\.(png|jpe?g|webp)$/i.test(fileName)) continue;
    const url = `/generated-images/${fileName}`;
    if (byUrl.has(url)) continue;
    const filePath = path.join(directory, fileName);
    byUrl.set(url, {
      id: fileName,
      url,
      filePath,
      createdAt: fs.statSync(filePath).mtime.toISOString()
    });
  }
  return [...byUrl.values()]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 80);
}

function attachmentBlock(size: number) {
  const phrase = "sunabot benchmark attachment needle42 deterministic content line\n";
  return phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size);
}

function benchmarkIso(offset: number) {
  return new Date(BASE_TIME + offset).toISOString();
}

function shouldSample(index: number, total: number) {
  const interval = Math.max(1, Math.floor(total / 100));
  return index % interval === 0 || index + 1 === total;
}

function rssSlopeBytesPerHour(samples: Array<{ at: number; rss: number }>) {
  if (samples.length < 2) return 0;
  const meanX = samples.reduce((sum, sample) => sum + sample.at, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample.rss, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.at - meanX) * (sample.rss - meanY);
    denominator += (sample.at - meanX) ** 2;
  }
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 60 * 60 * 1_000).toFixed(3));
}

function pause(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
