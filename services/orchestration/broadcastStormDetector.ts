import type { BroadcastStormConfig } from "../../src/types.js";

export interface CrossAccountReplyObservation {
  messageKey: string;
  groupId: number;
  sourceActorId: string;
  targetActorId: string;
  occurredAt?: string;
}

export interface BroadcastStormObservationResult {
  counted: boolean;
  triggered: boolean;
  blockedUntil?: string;
}

export interface ReplyTaskGate {
  canCreateTaskFor(occurredAt: string): boolean;
}

const MINUTE_MS = 60_000;
const MAX_SEEN_MESSAGES = 20_000;

export class BroadcastStormDetector implements ReplyTaskGate {
  private config: BroadcastStormConfig;
  private readonly replyTimes = new Map<number, number[]>();
  private readonly seenMessages = new Map<string, number>();
  private blockedUntil = 0;
  private lastBlockedUntil = 0;

  constructor(config: BroadcastStormConfig, private readonly now: () => number = Date.now) {
    this.config = structuredClone(config);
  }

  updateConfig(config: BroadcastStormConfig) {
    const changed = JSON.stringify(config) !== JSON.stringify(this.config);
    this.config = structuredClone(config);
    if (changed) {
      this.replyTimes.clear();
      this.seenMessages.clear();
    }
    if (!config.enabled) {
      this.blockedUntil = 0;
      this.lastBlockedUntil = 0;
    }
  }

  enabled() {
    return this.config.enabled;
  }

  isAdditionalQqId(qqId: string) {
    return this.config.additionalQqIds.includes(qqId.trim());
  }

  observe(input: CrossAccountReplyObservation): BroadcastStormObservationResult {
    const now = this.now();
    this.pruneSeenMessages(now);
    if (
      !this.config.enabled ||
      now < this.blockedUntil ||
      input.sourceActorId === input.targetActorId ||
      this.seenMessages.has(input.messageKey)
    ) {
      return { counted: false, triggered: false, ...this.blockStatus(now) };
    }

    this.seenMessages.set(input.messageKey, now);
    const windowStart = now - this.config.windowMinutes * MINUTE_MS;
    const occurredAt = Date.parse(input.occurredAt ?? "");
    const observationTime = Number.isFinite(occurredAt) ? Math.min(occurredAt, now) : now;
    if (observationTime < windowStart) return { counted: false, triggered: false };
    const replyTimes = (this.replyTimes.get(input.groupId) ?? []).filter((time) => time >= windowStart);
    replyTimes.push(observationTime);

    if (replyTimes.length < this.config.replyThreshold) {
      this.replyTimes.set(input.groupId, replyTimes);
      return { counted: true, triggered: false };
    }

    this.replyTimes.clear();
    this.blockedUntil = now + this.config.cooldownMinutes * MINUTE_MS;
    this.lastBlockedUntil = this.blockedUntil;
    return {
      counted: true,
      triggered: true,
      blockedUntil: new Date(this.blockedUntil).toISOString()
    };
  }

  canCreateTaskFor(occurredAt: string) {
    if (!this.config.enabled) return true;
    const now = this.now();
    if (now < this.blockedUntil) return false;
    const occurredAtMs = Date.parse(occurredAt);
    return this.lastBlockedUntil === 0 || (Number.isFinite(occurredAtMs) && occurredAtMs > this.lastBlockedUntil);
  }

  status() {
    const now = this.now();
    return {
      enabled: this.config.enabled,
      blocked: this.config.enabled && now < this.blockedUntil,
      ...(this.config.enabled && now < this.blockedUntil
        ? { blockedUntil: new Date(this.blockedUntil).toISOString() }
        : {})
    };
  }

  private blockStatus(now: number) {
    return this.config.enabled && now < this.blockedUntil
      ? { blockedUntil: new Date(this.blockedUntil).toISOString() }
      : {};
  }

  private pruneSeenMessages(now: number) {
    const retentionMs = Math.max(
      this.config.windowMinutes * MINUTE_MS,
      this.config.cooldownMinutes * MINUTE_MS
    );
    for (const [key, seenAt] of this.seenMessages) {
      if (now - seenAt <= retentionMs && this.seenMessages.size <= MAX_SEEN_MESSAGES) break;
      this.seenMessages.delete(key);
    }
  }
}
