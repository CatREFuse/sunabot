import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../../src/types.js";
import { resolveProjectPath } from "../../src/config.js";
import {
  GROUP_MEMORY_SELECTION_CONTEXT_LIMIT,
  GROUP_MEMORY_SELECTION_POLICY,
  isGroupMemoryScope,
  orderedUniqueMemoryMessages,
  selectGroupMemoryMessagesNearAssistant
} from "./groupMemoryWindow.js";
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

export interface MemoryEnqueueOptions {
  committedThrough?: number;
  reconcileGroupHistory?: true;
}

export interface MemoryClaim {
  conversation: MemoryConversationDescriptor;
  batchId: string;
  messageIds: string[];
  messages: MemoryQueuedMessage[];
  attemptMessageCount: number;
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
  groupMemorySelectionPolicy?: typeof GROUP_MEMORY_SELECTION_POLICY;
  groupMemorySelectionSource?: MemoryQueuedMessage[];
  dirty: boolean;
  failureCount: number;
  unattemptedMessageCount?: number;
  lastCommittedSequence: number;
  updatedAt: string;
}

interface SchedulerFile {
  version: 1;
  conversations: Record<string, StoredConversation>;
}

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
        if (conversation.unattemptedMessageCount == null) {
          conversation.unattemptedMessageCount = conversation.currentBatch || conversation.failureCount > 0
            ? 0
            : conversation.pendingMessages.length;
          changed = true;
        }
        if (conversation.state === "running") {
          conversation.state = "queued";
          conversation.dirty = true;
          conversation.updatedAt = new Date().toISOString();
          changed = true;
        }
        if ("silenceDueAt" in conversation) {
          delete (conversation as StoredConversation & { silenceDueAt?: string }).silenceDueAt;
          changed = true;
        }
        if ("nextRetryAt" in conversation) {
          delete (conversation as StoredConversation & { nextRetryAt?: string }).nextRetryAt;
          changed = true;
        }
        if (
          isGroupMemoryScope(conversation.conversation.scope) &&
          conversation.groupMemorySelectionPolicy === GROUP_MEMORY_SELECTION_POLICY &&
          this.normalizeGroupMemorySelectionContext(conversation) !== "valid"
        ) {
          changed = true;
        }
      }
      if (changed) await this.write(store);
      return store;
    });
  }

  async enqueue(
    conversation: MemoryConversationDescriptor,
    messages: MemoryQueuedMessage[],
    options: MemoryEnqueueOptions = {}
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

      let messagesToQueue = messages;
      let selectionSourceChanged = false;
      if (isGroupMemoryScope(conversation.scope)) {
        if (
          existing.groupMemorySelectionPolicy === GROUP_MEMORY_SELECTION_POLICY &&
          this.normalizeGroupMemorySelectionContext(existing) !== "valid"
        ) {
          selectionSourceChanged = true;
        }
        if (existing.groupMemorySelectionPolicy !== GROUP_MEMORY_SELECTION_POLICY) {
          if (options.reconcileGroupHistory !== true) {
            if (selectionSourceChanged) {
              store.conversations[conversation.id] = existing;
              await this.write(store);
            }
            return 0;
          }
          this.migrateGroupMemorySelection(existing, messages);
          selectionSourceChanged = true;
        }
        const selectionSource = orderedUniqueMemoryMessages([
          ...(existing.groupMemorySelectionSource ?? []),
          ...messages
        ]);
        const nextSelectionSource = selectionSource.slice(-GROUP_MEMORY_SELECTION_CONTEXT_LIMIT);
        selectionSourceChanged = selectionSourceChanged || !sameMessages(
          existing.groupMemorySelectionSource ?? [],
          nextSelectionSource
        );
        existing.groupMemorySelectionSource = nextSelectionSource;
        messagesToQueue = selectGroupMemoryMessagesNearAssistant(selectionSource);
      }

      const byKey = new Map(existing.pendingMessages.map((message) => [messageKey(message), message]));
      let added = 0;
      for (const message of messagesToQueue) {
        if (message.sequence <= existing.lastCommittedSequence) continue;
        const key = messageKey(message);
        if (byKey.has(key)) continue;
        byKey.set(key, message);
        added += 1;
      }
      existing.pendingMessages = [...byKey.values()].sort(compareMessages);
      if (added) {
        existing.unattemptedMessageCount = (existing.unattemptedMessageCount ?? 0) + added;
        if (existing.state === "running") existing.dirty = true;
        else existing.state = "queued";
      }
      existing.updatedAt = now.toISOString();
      store.conversations[conversation.id] = existing;
      if (added || selectionSourceChanged || options.committedThrough != null) await this.write(store);
      return added;
    });
  }

  async claimNext(threshold: number, nowMs = Date.now()): Promise<MemoryClaim | undefined> {
    return this.exclusive(async () => {
      const store = await this.read();
      const candidates = Object.values(store.conversations)
        .filter((item) => item.pendingMessages.length > 0 && item.state !== "running")
        .filter((item) => this.isConversationReady(item, threshold))
        .sort((left, right) => {
          const leftAt = left.pendingMessages[0]?.at ?? left.updatedAt;
          const rightAt = right.pendingMessages[0]?.at ?? right.updatedAt;
          return Date.parse(leftAt) - Date.parse(rightAt) || left.conversation.id.localeCompare(right.conversation.id);
        });
      const selected = candidates[0];
      if (!selected) return undefined;
      const currentBatchCommitted = this.isCurrentBatchCommitted(selected);

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
      const attemptMessageCount = currentBatchCommitted ? 0 : threshold;
      selected.unattemptedMessageCount = Math.max(
        0,
        (selected.unattemptedMessageCount ?? 0) - attemptMessageCount
      );
      selected.updatedAt = new Date(nowMs).toISOString();
      await this.write(store);
      return {
        conversation: selected.conversation,
        batchId,
        messageIds: messages.map(messageKey),
        messages,
        attemptMessageCount
      };
    });
  }

  async complete(claim: MemoryClaim, nowMs = Date.now(), options: { refundAttempt?: boolean } = {}) {
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
      if (options.refundAttempt) {
        conversation.unattemptedMessageCount = (conversation.unattemptedMessageCount ?? 0) + claim.attemptMessageCount;
      }
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
      conversation.state = "queued";
      conversation.dirty = true;
      conversation.updatedAt = new Date(nowMs).toISOString();
      await this.write(store);
    });
  }

  async nextWakeAt(threshold: number) {
    return this.exclusive(async () => {
      const store = await this.read();
      for (const conversation of Object.values(store.conversations)) {
        if (!conversation.pendingMessages.length || conversation.state === "running") continue;
        if (this.isConversationReady(conversation, threshold)) return Date.now();
      }
      return undefined;
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

  private migrateGroupMemorySelection(
    conversation: StoredConversation,
    conversationMessages: readonly MemoryQueuedMessage[]
  ) {
    const selectionSource = orderedUniqueMemoryMessages([
      ...conversation.pendingMessages,
      ...conversationMessages
    ]);
    const selected = selectGroupMemoryMessagesNearAssistant(selectionSource)
      .filter((message) => message.sequence > conversation.lastCommittedSequence);
    const currentBatchCommitted = this.isCurrentBatchCommitted(conversation);
    const currentBatchKeys = new Set(conversation.currentBatch?.messageIds ?? []);
    const selectedByKey = new Map(selected.map((message) => [messageKey(message), message]));

    if (currentBatchCommitted) {
      for (const message of conversation.pendingMessages) {
        if (currentBatchKeys.has(messageKey(message))) selectedByKey.set(messageKey(message), message);
      }
    } else {
      conversation.currentBatch = undefined;
      conversation.failureCount = 0;
    }

    conversation.pendingMessages = [...selectedByKey.values()].sort(compareMessages);
    conversation.unattemptedMessageCount = conversation.pendingMessages
      .filter((message) => !currentBatchKeys.has(messageKey(message)))
      .length;
    conversation.groupMemorySelectionPolicy = GROUP_MEMORY_SELECTION_POLICY;
    conversation.groupMemorySelectionSource = selectionSource.slice(-GROUP_MEMORY_SELECTION_CONTEXT_LIMIT);
    conversation.state = conversation.pendingMessages.length ? "queued" : "idle";
    conversation.dirty = false;
    conversation.updatedAt = new Date().toISOString();
  }

  private isCurrentBatchCommitted(conversation: StoredConversation) {
    return Boolean(
      conversation.currentBatch?.batchId &&
      memoryRepository(this.config).hasMemoryBatch(conversation.currentBatch.batchId)
    );
  }

  private normalizeGroupMemorySelectionContext(conversation: StoredConversation) {
    const source = normalizeGroupMemorySelectionSource(conversation.groupMemorySelectionSource);
    if (!source) {
      conversation.groupMemorySelectionPolicy = undefined;
      conversation.groupMemorySelectionSource = undefined;
      return "invalid" as const;
    }
    if (!sameMessages(conversation.groupMemorySelectionSource ?? [], source)) {
      conversation.groupMemorySelectionSource = source;
      return "repaired" as const;
    }
    return "valid" as const;
  }

  private isConversationReady(conversation: StoredConversation, threshold: number) {
    if (isGroupMemoryScope(conversation.conversation.scope)) {
      if (conversation.groupMemorySelectionPolicy !== GROUP_MEMORY_SELECTION_POLICY) return false;
      const source = normalizeGroupMemorySelectionSource(conversation.groupMemorySelectionSource);
      if (
        !source?.length ||
        !sameMessages(conversation.groupMemorySelectionSource ?? [], source)
      ) return false;
    }
    return this.isCurrentBatchCommitted(conversation) ||
      (conversation.unattemptedMessageCount ?? 0) >= threshold;
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
    unattemptedMessageCount: 0,
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

function sameMessages(left: readonly MemoryQueuedMessage[], right: readonly MemoryQueuedMessage[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeGroupMemorySelectionSource(value: unknown) {
  if (!Array.isArray(value) || !value.every(isMemoryQueuedMessage)) return undefined;
  return orderedUniqueMemoryMessages(value).slice(-GROUP_MEMORY_SELECTION_CONTEXT_LIMIT);
}

function isMemoryQueuedMessage(value: unknown): value is MemoryQueuedMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<MemoryQueuedMessage>;
  return typeof message.id === "string" && message.id.length > 0 &&
    Number.isSafeInteger(message.sequence) && Number(message.sequence) > 0 &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string" && message.text.trim().length > 0 &&
    typeof message.at === "string" && Number.isFinite(Date.parse(message.at)) &&
    (message.userId == null || Number.isSafeInteger(message.userId)) &&
    (message.senderName == null || typeof message.senderName === "string") &&
    Number.isSafeInteger(message.imageCount) && Number(message.imageCount) >= 0 &&
    Number.isSafeInteger(message.quoteCount) && Number(message.quoteCount) >= 0;
}
