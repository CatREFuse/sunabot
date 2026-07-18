import type {
  ClaimedTurn,
  HeldOutboxAppendOptions,
  HeldOutboxReplyGateV1,
  OutboxDraft,
  OutboxRecord
} from "./sessionTypes.js";
import type { SessionStore } from "./sessionStore.js";

export async function emitTurnOutbox(
  store: SessionStore,
  claim: ClaimedTurn,
  workerId: string,
  ordinal: number,
  draft: OutboxDraft,
  assertUsable: () => void,
  scheduleOutbox: () => void
): Promise<OutboxRecord> {
  assertUsable();
  const appended = store.appendTurnOutbox({
    turnId: claim.turn.id,
    workerId,
    dedupeKey: `turn-outbox:${claim.event.id}:${ordinal}`,
    draft
  });
  scheduleOutbox();
  return appended.outbox;
}

export interface DeferredTurnOutboxEmitter {
  emit(draft: OutboxDraft): Promise<OutboxRecord>;
  release(providerCallId: string): void;
  reject(error: unknown): void;
}

export function createDeferredTurnOutboxEmitter(
  store: SessionStore,
  claim: ClaimedTurn,
  nextOrdinal: () => number,
  scheduleOutbox: () => void
): DeferredTurnOutboxEmitter {
  type PendingAppend = {
    draft: OutboxDraft;
    ordinal: number;
    resolve: (outbox: OutboxRecord) => void;
    reject: (error: unknown) => void;
  };
  let state:
    | { status: "pending" }
    | { status: "released"; providerCallId: string }
    | { status: "rejected"; error: unknown } = { status: "pending" };
  const pending: PendingAppend[] = [];
  const append = (draft: OutboxDraft, ordinal: number, providerCallId: string) => {
    const appended = store.appendDeferredTurnOutbox({
      turnId: claim.turn.id,
      eventId: claim.event.id,
      providerCallId,
      dedupeKey: `turn-outbox:${claim.event.id}:${ordinal}`,
      draft
    });
    scheduleOutbox();
    return appended.outbox;
  };
  const settlePending = () => {
    if (state.status === "pending") return;
    const settled = state;
    for (const item of pending.splice(0)) {
      if (settled.status === "rejected") {
        item.reject(settled.error);
        continue;
      }
      try {
        item.resolve(append(item.draft, item.ordinal, settled.providerCallId));
      } catch (error) {
        item.reject(error);
      }
    }
  };
  return {
    emit(draft) {
      const ordinal = nextOrdinal();
      const current = state;
      if (current.status === "released") {
        const { providerCallId } = current;
        return Promise.resolve().then(() => append(draft, ordinal, providerCallId));
      }
      if (current.status === "rejected") return Promise.reject(current.error);
      return new Promise<OutboxRecord>((resolve, reject) => {
        pending.push({ draft, ordinal, resolve, reject });
      });
    },
    release(providerCallId) {
      if (state.status !== "pending") return;
      state = { status: "released", providerCallId };
      settlePending();
    },
    reject(error) {
      if (state.status !== "pending") return;
      state = { status: "rejected", error };
      settlePending();
    }
  };
}

export interface TurnHeldOutboxHandle {
  outbox: OutboxRecord;
  release(replyGate: HeldOutboxReplyGateV1): Promise<OutboxRecord>;
  neutralizeAndRelease(replyGate: HeldOutboxReplyGateV1): Promise<OutboxRecord>;
}

export async function emitTurnHeldOutbox(
  store: SessionStore,
  claim: ClaimedTurn,
  workerId: string,
  ordinal: number,
  draft: OutboxDraft,
  hold: HeldOutboxAppendOptions,
  assertUsable: () => void,
  scheduleOutbox: () => void
): Promise<TurnHeldOutboxHandle> {
  assertUsable();
  const appended = store.appendHeldTurnOutbox({
    turnId: claim.turn.id,
    workerId,
    dedupeKey: `turn-outbox:${claim.event.id}:${ordinal}`,
    draft,
    hold
  });
  const release = async (
    replyGate: HeldOutboxReplyGateV1,
    fallback: boolean
  ) => {
    assertUsable();
    const released = fallback
      ? store.neutralizeAndReleaseHeldOutbox({
          outboxId: appended.outbox.id,
          mutationFingerprint: hold.mutationFingerprint,
          replyGate
        })
      : store.releaseHeldOutbox({
          outboxId: appended.outbox.id,
          mutationFingerprint: hold.mutationFingerprint,
          replyGate
        });
    scheduleOutbox();
    return released;
  };
  return {
    outbox: appended.outbox,
    release: (replyGate) => release(replyGate, false),
    neutralizeAndRelease: (replyGate) => release(replyGate, true)
  };
}
