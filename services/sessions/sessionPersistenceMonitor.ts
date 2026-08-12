import type { SessionClaimState } from "./sessionCoordinatorTypes.js";

export class SessionPersistenceMonitor {
  private lastFailure?: { code: string; recordId: string; at: number };

  constructor(
    private readonly leaseMs: number,
    private readonly clock: () => number,
    private readonly onError?: (error: unknown, context: { code: string; recordId: string }) => void
  ) {}

  claim(renew: () => boolean, recordId: string): SessionClaimState {
    const controller = new AbortController();
    const interval = setInterval(() => {
      try {
        if (!renew() && !controller.signal.aborted) {
          controller.abort(new Error("Persistent lease ownership was lost."));
        }
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        this.record(error, "LEASE_RENEWAL_PERSIST_FAILED", recordId);
      }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    interval.unref?.();
    return {
      controller,
      finalized: false,
      finalizationAttempted: false,
      stopRenewal: () => clearInterval(interval)
    };
  }

  health() {
    return this.lastFailure
      ? { status: "degraded" as const, ...this.lastFailure }
      : { status: "ready" as const };
  }

  record(error: unknown, code: string, recordId: string) {
    this.lastFailure = { code, recordId, at: this.clock() };
    console.error("[sessions] durable persistence failed", { code, recordId, error: safeError(error) });
    try {
      this.onError?.(error, { code, recordId });
    } catch (callbackError) {
      console.error("[sessions] persistence error observer failed", { error: safeError(callbackError) });
    }
  }
}

function safeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}
