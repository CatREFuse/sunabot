import type { ClaimedTurn, OutboxDraft, OutboxRecord } from "./sessionTypes.js";
import type { SessionStore } from "./sessionStore.js";

const DELIVERY_POLL_MS = 2;

export async function emitTurnOutbox(
  store: SessionStore,
  claim: ClaimedTurn,
  workerId: string,
  signal: AbortSignal,
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

  while (true) {
    assertUsable();
    const outbox = store.getOutbox(appended.outbox.id);
    if (!outbox) throw new Error(`Outbox item not found: ${appended.outbox.id}`);
    if (outbox.remoteSentAt != null || outbox.status === "sent") return outbox;
    if (outbox.status === "dead" || outbox.status === "delivery_unknown") {
      throw new Error(`Outbox ${outbox.id} reached ${outbox.status} before remote delivery.`);
    }
    await abortableDelay(DELIVERY_POLL_MS, signal);
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation was aborted."));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Operation was aborted."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
