import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../../src/types.js";
import { resolveProjectPath } from "../../src/config.js";
import { memoryDatabasePath, memoryRepository } from "./persistence.js";

export type MemorySchedulerStatus = "idle" | "queued" | "running";

export interface MemoryConversationDescriptor {
  id: string;
  scope: string;
  title: string;
  userId?: number;
  groupId?: number;
}

export interface MemoryQueuedMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  userId?: number;
  senderName?: string;
  imageCount: number;
  quoteCount: number;
}

export interface MemoryClaim {
  conversation: MemoryConversationDescriptor;
  batchId: string;
  messageIds: string[];
  messages: MemoryQueuedMessage[];
}

interface StoredBatch {
  batchId: string;
  messageIds: string[];
  startedAt: string;
}

interface StoredConversation {
  conversation: MemoryConversationDescriptor;
  state: MemorySchedulerStatus;
  pendingMessages: MemoryQueuedMessage[];
  currentBatch?: StoredBatch;
  dirty: boolean;
  silenceDueAt?: string;
  failureCount: number;
  nextRetryAt?: string;
  lastCommittedSequence: number;
  updatedAt: string;
}

interface SchedulerFile {
  version: 1;
  conversations: Record<string, StoredConversation>;
}

const FAILURE_DELAYS_MS = [30_000, 120_000, 600_000] as const;

export class MemorySchedulerStore {
  private config: AppConfig;
  private queue = Promise.resolve();

  constructor(config: AppConfig) {
    this.config = config;
  }

  setConfig(config: AppConfig) {
    this.config = config;
  }

  async initialize() {
    return this.exclusive(async () => {
      const store = await this.read();
      let changed = false;
      for (const conversation of Object.values(store.conversations)) {
        if (conversation.state !== "running") continue;
        conversation.state = "queued";
        conversation.dirty = true;
        conversation.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) await this.write(store);
      return store;
    });
  }

  async enqueue(
    conversation: MemoryConversationDescriptor,
    messages: MemoryQueuedMessage[],
    options: { committedThrough?: number; idleDelayMs?: number } = {}
  ) {
    return this.exclusive(async () => {
      const store = await this.read();
      const now = new Date();
      const previous = store.conversations[conversation.id];
      const existing = previous ?? newConversationState(
        conversation,
        options.committedThrough ?? 0,
        now.toISOString()
      );
      existing.conversation = conversation;
      if (!previous) {
        existing.lastCommittedSequence = Math.max(existing.lastCommittedSequence, options.committedThrough ?? 0);
      }

      const byKey = new Map(existing.pendingMessages.map((message) => [messageKey(message), message]));
      let added = 0;
      for (const message of messages) {
        if (message.sequence <= existing.lastCommittedSequence) continue;
        const key = messageKey(message);
        if (byKey.has(key)) continue;
        byKey.set(key, message);
        added += 1;
      }
      existing.pendingMessages = [...byKey.values()].sort(compareMessages);
      if (added) {
        const last = existing.pendingMessages[existing.pendingMessages.length - 1];
        const receivedAt = last ? Date.parse(last.at) : now.getTime();
        const base = Number.isFinite(receivedAt) ? receivedAt : now.getTime();
        existing.silenceDueAt = new Date(base + (options.idleDelayMs ?? 300_000)).toISOString();
        if (existing.state === "running") existing.dirty = true;
        else existing.state = "queued";
      }
      existing.updatedAt = now.toISOString();
      store.conversations[conversation.id] = existing;
      if (added || options.committedThrough != null) await this.write(store);
      return added;
    });
  }

  async claimNext(threshold: number, nowMs = Date.now()): Promise<MemoryClaim | undefined> {
    return this.exclusive(async () => {
      const store = await this.read();
      const candidates = Object.values(store.conversations)
        .filter((item) => item.pendingMessages.length > 0 && item.state !== "running")
        .filter((item) => !item.nextRetryAt || Date.parse(item.nextRetryAt) <= nowMs)
        .filter((item) => item.pendingMessages.length >= threshold || dueAt(item) <= nowMs)
        .sort((left, right) => {
          const leftAt = left.pendingMessages[0]?.at ?? left.updatedAt;
          const rightAt = right.pendingMessages[0]?.at ?? right.updatedAt;
          return Date.parse(leftAt) - Date.parse(rightAt) || left.conversation.id.localeCompare(right.conversation.id);
        });
      const selected = candidates[0];
      if (!selected) return undefined;

      let messages: MemoryQueuedMessage[];
      let batchId: string;
      if (selected.currentBatch) {
        const ids = new Set(selected.currentBatch.messageIds);
        messages = selected.pendingMessages.filter((message) => ids.has(messageKey(message)));
        batchId = selected.currentBatch.batchId;
      } else {
        messages = selected.pendingMessages.slice(0, Math.max(1, threshold));
        batchId = createBatchId(selected.conversation.id, messages);
        selected.currentBatch = {
          batchId,
          messageIds: messages.map(messageKey),
          startedAt: new Date(nowMs).toISOString()
        };
      }
      if (!messages.length) {
        selected.currentBatch = undefined;
        selected.state = selected.pendingMessages.length ? "queued" : "idle";
        selected.updatedAt = new Date(nowMs).toISOString();
        await this.write(store);
        return undefined;
      }
      selected.state = "running";
      selected.dirty = false;
      selected.updatedAt = new Date(nowMs).toISOString();
      await this.write(store);
      return {
        conversation: selected.conversation,
        batchId,
        messageIds: messages.map(messageKey),
        messages
      };
    });
  }

  async complete(claim: MemoryClaim, nowMs = Date.now()) {
    return this.exclusive(async () => {
      const store = await this.read();
      const conversation = store.conversations[claim.conversation.id];
      if (!conversation) return;
      const committed = new Set(claim.messageIds);
      const completedMessages = conversation.pendingMessages.filter((message) => committed.has(messageKey(message)));
      conversation.pendingMessages = conversation.pendingMessages.filter((message) => !committed.has(messageKey(message)));
      conversation.lastCommittedSequence = Math.max(
        conversation.lastCommittedSequence,
        ...completedMessages.map((message) => message.sequence)
      );
      conversation.currentBatch = undefined;
      conversation.failureCount = 0;
      conversation.nextRetryAt = undefined;
      conversation.dirty = false;
      conversation.state = conversation.pendingMessages.length ? "queued" : "idle";
      conversation.updatedAt = new Date(nowMs).toISOString();
      await this.write(store);
    });
  }

  async fail(claim: MemoryClaim, nowMs = Date.now()) {
    return this.exclusive(async () => {
      const store = await this.read();
      const conversation = store.conversations[claim.conversation.id];
      if (!conversation) return;
      conversation.failureCount += 1;
      const delay = FAILURE_DELAYS_MS[Math.min(conversation.failureCount - 1, FAILURE_DELAYS_MS.length - 1)]!;
      conversation.nextRetryAt = new Date(nowMs + delay).toISOString();
      conversation.state = "queued";
      conversation.dirty = true;
      conversation.updatedAt = new Date(nowMs).toISOString();
      await this.write(store);
    });
  }

  async nextWakeAt(threshold: number) {
    return this.exclusive(async () => {
      const store = await this.read();
      let next = Number.POSITIVE_INFINITY;
      for (const conversation of Object.values(store.conversations)) {
        if (!conversation.pendingMessages.length || conversation.state === "running") continue;
        const retry = conversation.nextRetryAt ? Date.parse(conversation.nextRetryAt) : 0;
        if (retry > Date.now()) {
          next = Math.min(next, retry);
          continue;
        }
        if (conversation.pendingMessages.length >= threshold) return Date.now();
        next = Math.min(next, dueAt(conversation));
      }
      return Number.isFinite(next) ? next : undefined;
    });
  }

  async snapshot() {
    return this.exclusive(() => this.read());
  }

  databasePath() {
    return memoryDatabasePath(this.config);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private legacyFilePath() {
    const workspace = resolveProjectPath(this.config.persona.agentWorkspace);
    if (!workspace) throw new Error("Agent workspace is not configured.");
    return path.join(workspace, "MEMORY_SCHEDULER.json");
  }

  private async read(): Promise<SchedulerFile> {
    const store = memoryRepository(this.config);
    store.ensureLegacyMemorySchedulerImported(this.legacyFilePath());
    return {
      version: 1,
      conversations: store.readMemoryScheduler() as unknown as Record<string, StoredConversation>
    };
  }

  private async write(store: SchedulerFile) {
    memoryRepository(this.config).replaceMemoryScheduler(store.conversations);
  }
}

function newConversationState(
  conversation: MemoryConversationDescriptor,
  committedThrough: number,
  now: string
): StoredConversation {
  return {
    conversation,
    state: "idle",
    pendingMessages: [],
    dirty: false,
    failureCount: 0,
    lastCommittedSequence: committedThrough,
    updatedAt: now
  };
}

function createBatchId(conversationId: string, messages: MemoryQueuedMessage[]) {
  const ids = messages.map(messageKey).join("\n");
  return `sha256:${createHash("sha256").update(`${conversationId}\n${ids}`).digest("hex")}`;
}

function messageKey(message: MemoryQueuedMessage) {
  return `${message.sequence}:${message.id}`;
}

function compareMessages(left: MemoryQueuedMessage, right: MemoryQueuedMessage) {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function dueAt(conversation: StoredConversation) {
  const due = conversation.silenceDueAt ? Date.parse(conversation.silenceDueAt) : Number.POSITIVE_INFINITY;
  return Number.isFinite(due) ? due : Number.POSITIVE_INFINITY;
}
