import type { ScheduledTaskRun } from "./scheduledTask.js";
import type { ScheduledTaskStore } from "./scheduledTaskStore.js";

const DEFAULT_LEASE_MS = 60_000;
const MAX_DRAIN_ITEMS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DELIVERY_RETRY_BASE_MS = 30_000;

export interface ScheduledTaskSchedulerErrorContext {
  phase: "generate" | "deliver";
  run: ScheduledTaskRun;
}

export interface ScheduledTaskSchedulerOptions {
  store: ScheduledTaskStore;
  workerId: string;
  generate: (run: ScheduledTaskRun, signal: AbortSignal) => Promise<string>;
  deliver: (run: ScheduledTaskRun, signal: AbortSignal) => Promise<void>;
  leaseMs?: number;
  clock?: () => Date;
  random?: () => number;
  onError?: (error: unknown, context: ScheduledTaskSchedulerErrorContext) => void;
}

export interface ScheduledTaskDrainResult {
  claimedOccurrences: number;
  claimedRuns: number;
  generatedRuns: number;
  deliveredRuns: number;
  completedRuns: number;
  failedRuns: number;
}

export class ScheduledTaskScheduler {
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly random: () => number;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private wakeAt?: string;
  private drainPromise?: Promise<ScheduledTaskDrainResult>;
  private activeController?: AbortController;

  constructor(private readonly options: ScheduledTaskSchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.leaseMs = positiveLease(options.leaseMs ?? DEFAULT_LEASE_MS);
    if (!options.workerId.trim()) throw new Error("Scheduled task scheduler workerId is required.");
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.wake();
  }

  stop() {
    this.started = false;
    this.clearTimer();
    this.activeController?.abort();
  }

  wake() {
    if (!this.started) return;
    this.clearTimer();
    void this.runOnce();
  }

  runOnce(): Promise<ScheduledTaskDrainResult> {
    if (this.drainPromise) return this.drainPromise;
    const drain = this.drain();
    const tracked = drain.finally(() => {
      if (this.drainPromise === tracked) this.drainPromise = undefined;
      if (this.started) this.arm();
    });
    this.drainPromise = tracked;
    return tracked;
  }

  private async drain(): Promise<ScheduledTaskDrainResult> {
    this.options.store.purgeExpiredArchivedTasks({ now: this.now() });
    const result: ScheduledTaskDrainResult = {
      claimedOccurrences: 0,
      claimedRuns: 0,
      generatedRuns: 0,
      deliveredRuns: 0,
      completedRuns: 0,
      failedRuns: 0
    };

    while (result.claimedOccurrences < MAX_DRAIN_ITEMS) {
      const occurrence = this.options.store.claimDueOccurrence({ now: this.now() });
      if (!occurrence) break;
      result.claimedOccurrences += 1;
    }

    while (result.claimedRuns < MAX_DRAIN_ITEMS) {
      const run = this.options.store.claimPendingRun({
        workerId: this.options.workerId,
        leaseMs: this.leaseMs,
        now: this.now()
      });
      if (!run) break;
      result.claimedRuns += 1;
      if (run.status === "generated") {
        const delivery = await this.deliver(run);
        if (delivery === "completed") {
          result.deliveredRuns += 1;
          result.completedRuns += 1;
        } else if (delivery === "failed") {
          result.failedRuns += 1;
        }
        continue;
      }
      const generated = await this.generate(run);
      if (!generated) {
        result.failedRuns += 1;
        continue;
      }
      result.generatedRuns += 1;
      const delivery = await this.deliver(generated);
      if (delivery === "completed") {
        result.deliveredRuns += 1;
        result.completedRuns += 1;
      } else if (delivery === "failed") {
        result.failedRuns += 1;
      }
    }
    return result;
  }

  private async generate(run: ScheduledTaskRun) {
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const resultText = await this.withLeaseRenewal(run, controller, () => this.options.generate(run, controller.signal));
      if (controller.signal.aborted) return undefined;
      return this.options.store.markGenerated({
        runId: run.id,
        workerId: this.options.workerId,
        resultText,
        now: this.now()
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.options.store.fail({
          runId: run.id,
          workerId: this.options.workerId,
          errorText: errorMessage(error),
          now: this.now()
        });
        this.options.onError?.(error, { phase: "generate", run });
      }
      return undefined;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async deliver(run: ScheduledTaskRun) {
    const controller = new AbortController();
    this.activeController = controller;
    try {
      await this.withLeaseRenewal(run, controller, () => this.options.deliver(run, controller.signal));
      if (controller.signal.aborted) return "retrying" as const;
      return this.options.store.complete({
        runId: run.id,
        workerId: this.options.workerId,
        now: this.now()
      }) ? "completed" as const : "retrying" as const;
    } catch (error) {
      if (controller.signal.aborted) return "retrying" as const;
      const now = this.now();
      const retryAt = new Date(now.getTime() + deliveryRetryDelay(run.deliveryAttempts + 1, this.random()));
      const recorded = this.options.store.recordDeliveryFailure({
        runId: run.id,
        workerId: this.options.workerId,
        errorText: errorMessage(error),
        retryAt,
        now
      });
      this.options.onError?.(error, { phase: "deliver", run });
      return recorded?.terminal ? "failed" as const : "retrying" as const;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async withLeaseRenewal<T>(run: ScheduledTaskRun, controller: AbortController, operation: () => Promise<T>) {
    const delay = Math.max(25, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      try {
        const renewed = this.options.store.renew({
          runId: run.id,
          workerId: this.options.workerId,
          leaseMs: this.leaseMs,
          now: this.now()
        });
        if (!renewed) throw new Error("Scheduled task lease was lost.");
      } catch (error) {
        controller.abort(error);
        this.options.onError?.(error, { phase: run.status === "generated" ? "deliver" : "generate", run });
      }
    }, delay);
    timer.unref?.();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
    }
  }

  private arm() {
    const wakeAt = this.options.store.nextWakeAt();
    if (!wakeAt) {
      this.clearTimer();
      return;
    }
    if (this.timer && this.wakeAt === wakeAt) return;
    this.clearTimer();
    this.wakeAt = wakeAt;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Date.parse(wakeAt) - this.now().getTime()));
    const timer = setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      this.wakeAt = undefined;
      void this.runOnce();
    }, delay);
    timer.unref?.();
    this.timer = timer;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeAt = undefined;
  }

  private now() {
    const date = this.clock();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new Error("Scheduled task scheduler clock returned an invalid date.");
    }
    return new Date(date.getTime());
  }
}

function deliveryRetryDelay(attempt: number, random: number) {
  if (!Number.isFinite(random) || random < 0 || random > 1) throw new Error("Scheduled task retry jitter is invalid.");
  const base = Math.min(15 * 60_000, DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random * 0.4));
}

function positiveLease(value: number) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 86_400_000) {
    throw new Error("Scheduled task scheduler leaseMs must be between 100 and 86400000.");
  }
  return value;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error) || "Scheduled task execution failed.";
}
