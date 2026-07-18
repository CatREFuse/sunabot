import type { ScheduledTaskRun } from "./scheduledTask.js";
import type { ScheduledTaskStore } from "./scheduledTaskStore.js";

const DEFAULT_LEASE_MS = 60_000;
const MAX_DRAIN_ITEMS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private wakeAt?: string;
  private drainPromise?: Promise<ScheduledTaskDrainResult>;
  private activeController?: AbortController;

  constructor(private readonly options: ScheduledTaskSchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
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
        if (await this.deliver(run)) {
          result.deliveredRuns += 1;
          result.completedRuns += 1;
        }
        continue;
      }
      const generated = await this.generate(run);
      if (!generated) {
        result.failedRuns += 1;
        continue;
      }
      result.generatedRuns += 1;
      if (await this.deliver(generated)) {
        result.deliveredRuns += 1;
        result.completedRuns += 1;
      }
    }
    return result;
  }

  private async generate(run: ScheduledTaskRun) {
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const resultText = await this.withLeaseRenewal(run, () => this.options.generate(run, controller.signal));
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
      await this.withLeaseRenewal(run, () => this.options.deliver(run, controller.signal));
      if (controller.signal.aborted) return false;
      return Boolean(this.options.store.complete({
        runId: run.id,
        workerId: this.options.workerId,
        now: this.now()
      }));
    } catch (error) {
      if (!controller.signal.aborted) this.options.onError?.(error, { phase: "deliver", run });
      return false;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async withLeaseRenewal<T>(run: ScheduledTaskRun, operation: () => Promise<T>) {
    const delay = Math.max(25, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      this.options.store.renew({
        runId: run.id,
        workerId: this.options.workerId,
        leaseMs: this.leaseMs,
        now: this.now()
      });
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
