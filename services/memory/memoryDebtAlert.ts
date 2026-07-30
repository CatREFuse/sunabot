import { randomUUID } from "node:crypto";
import type { MemoryRepositoryPort } from "./persistence.js";

export const MEMORY_DEBT_ALERT_THRESHOLD = 100;

export interface MemoryDebtAlertClaim {
  episodeId: string;
  pendingMessageCount: number;
  threshold: number;
  targetConversationId?: string;
}

interface StoredMemoryDebtAlertState {
  schemaVersion: 1;
  active: boolean;
  episodeId: string | null;
  queued: boolean;
  targetConversationId?: string;
  updatedAt: string;
}

export function claimMemoryDebtAlert(
  repository: MemoryRepositoryPort,
  pendingMessageCount: number,
  threshold: number,
  nowMs: number
): MemoryDebtAlertClaim | undefined {
  const normalizedThreshold = positiveThreshold(threshold);
  const current = readMemoryDebtAlertState(repository, nowMs);
  if (pendingMessageCount <= normalizedThreshold) {
    resetActiveDebtAlert(repository, current, nowMs);
    return undefined;
  }
  if (current?.active) {
    if (current.queued) return undefined;
    return {
      episodeId: current.episodeId!,
      pendingMessageCount,
      threshold: normalizedThreshold,
      ...(current.targetConversationId ? {
        targetConversationId: current.targetConversationId
      } : {})
    };
  }

  const episodeId = randomUUID();
  repository.writeMemoryDebtAlertState({
    schemaVersion: 1,
    active: true,
    episodeId,
    queued: false,
    updatedAt: new Date(nowMs).toISOString()
  });
  return { episodeId, pendingMessageCount, threshold: normalizedThreshold };
}

export function bindMemoryDebtAlertTarget(
  repository: MemoryRepositoryPort,
  episodeId: string,
  targetConversationId: string,
  nowMs: number
) {
  const normalizedEpisodeId = requiredEpisodeId(episodeId);
  const normalizedTarget = requiredDebtAlertConversationId(targetConversationId);
  const current = readMemoryDebtAlertState(repository, nowMs);
  if (!current?.active || current.episodeId !== normalizedEpisodeId) return undefined;
  if (current.targetConversationId) return current.targetConversationId;
  if (current.queued) return undefined;
  repository.writeMemoryDebtAlertState({
    ...current,
    targetConversationId: normalizedTarget,
    updatedAt: new Date(nowMs).toISOString()
  });
  return normalizedTarget;
}

export async function enqueueMemoryDebtAlertIfDue<T extends { queued: boolean }>(
  repository: MemoryRepositoryPort,
  pendingMessageCount: number,
  input: {
    episodeId: string;
    targetConversationId: string;
    threshold: number;
    nowMs: number;
  },
  enqueue: () => Promise<T>
): Promise<
  | { executed: false; reason: "not_due" | "episode_changed" }
  | { executed: true; result: T }
> {
  const normalizedEpisodeId = requiredEpisodeId(input.episodeId);
  const normalizedTarget = requiredDebtAlertConversationId(input.targetConversationId);
  const normalizedThreshold = positiveThreshold(input.threshold);
  const current = readMemoryDebtAlertState(repository, input.nowMs);
  if (pendingMessageCount <= normalizedThreshold) {
    resetActiveDebtAlert(repository, current, input.nowMs);
    return { executed: false, reason: "not_due" };
  }
  if (
    !current?.active ||
    current.episodeId !== normalizedEpisodeId ||
    current.queued ||
    current.targetConversationId !== normalizedTarget
  ) {
    return { executed: false, reason: "episode_changed" };
  }

  const result = await enqueue();
  if (result.queued) {
    repository.writeMemoryDebtAlertState({
      ...current,
      queued: true,
      updatedAt: new Date(input.nowMs).toISOString()
    });
  }
  return { executed: true, result };
}

export function markMemoryDebtAlertQueued(
  repository: MemoryRepositoryPort,
  episodeId: string,
  nowMs: number
) {
  const normalizedEpisodeId = requiredEpisodeId(episodeId);
  const current = readMemoryDebtAlertState(repository, nowMs);
  if (!current?.active || current.episodeId !== normalizedEpisodeId) return false;
  if (current.queued) return true;
  if (!current.targetConversationId) return false;
  repository.writeMemoryDebtAlertState({
    ...current,
    queued: true,
    updatedAt: new Date(nowMs).toISOString()
  });
  return true;
}

function resetActiveDebtAlert(
  repository: MemoryRepositoryPort,
  current: StoredMemoryDebtAlertState | undefined,
  nowMs: number
) {
  if (!current?.active) return;
  repository.writeMemoryDebtAlertState({
    schemaVersion: 1,
    active: false,
    episodeId: null,
    queued: false,
    updatedAt: new Date(nowMs).toISOString()
  });
}

function positiveThreshold(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Memory debt alert threshold must be a positive integer.");
  }
  return value;
}

function requiredEpisodeId(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new Error("Memory debt alert episode id is invalid.");
  }
  return normalized;
}

function requiredDebtAlertConversationId(value: string) {
  const normalized = value.trim();
  const match = normalized.match(/^(?:account:[A-Za-z0-9_-]{1,64}:)?private:([1-9]\d*)$/u);
  const userId = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Memory debt alert target conversation id is invalid.");
  }
  return normalized;
}

function readMemoryDebtAlertState(repository: MemoryRepositoryPort, nowMs: number) {
  const value = repository.readMemoryDebtAlertState();
  if (!isLegacyQueuedDebtAlertWithoutTarget(value)) {
    return parseMemoryDebtAlertState(value);
  }
  const recoveredValue: Record<string, unknown> = {
    ...value,
    queued: false,
    updatedAt: new Date(nowMs).toISOString()
  };
  delete recoveredValue.targetConversationId;
  const recovered = parseMemoryDebtAlertState(recoveredValue);
  if (!recovered) throw new Error("Stored memory debt alert state is invalid.");
  repository.writeMemoryDebtAlertState({ ...recovered });
  return recovered;
}

function isLegacyQueuedDebtAlertWithoutTarget(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.schemaVersion === 1 &&
    state.active === true &&
    state.queued === true &&
    state.targetConversationId == null;
}

function parseMemoryDebtAlertState(value: unknown): StoredMemoryDebtAlertState | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored memory debt alert state is invalid.");
  }
  const state = value as Partial<StoredMemoryDebtAlertState>;
  const episodeId = state.episodeId;
  const targetConversationId = state.targetConversationId;
  if (
    state.schemaVersion !== 1 ||
    typeof state.active !== "boolean" ||
    typeof state.queued !== "boolean" ||
    typeof state.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    (state.active
      ? typeof episodeId !== "string" ||
        requiredEpisodeId(episodeId) !== episodeId ||
        (
          targetConversationId !== undefined &&
          requiredDebtAlertConversationId(targetConversationId) !== targetConversationId
        ) ||
        (state.queued && targetConversationId === undefined)
      : episodeId !== null || state.queued || targetConversationId !== undefined)
  ) {
    throw new Error("Stored memory debt alert state is invalid.");
  }
  return {
    schemaVersion: 1,
    active: state.active,
    episodeId: state.active ? episodeId as string : null,
    queued: state.queued,
    ...(targetConversationId ? { targetConversationId } : {}),
    updatedAt: state.updatedAt
  };
}
