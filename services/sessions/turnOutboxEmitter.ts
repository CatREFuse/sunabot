import type { ClaimedTurn, OutboxDraft, OutboxRecord } from "./sessionTypes.js";
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
