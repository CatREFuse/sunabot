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
