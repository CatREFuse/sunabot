import path from "node:path";
import type {
  CodexRunner,
  CodexToolInput,
  CodexToolResult
} from "../../packages/contracts/tools/codex.js";
import { SessionActorTaskTimeoutError } from "./sessionActor.js";
import type { SessionStore, ToolJobRecord } from "./sessionStore.js";
import type {
  ClaimedToolTask,
  CodexProcessCleanup,
  DeferredToolRunner,
  SessionClaimState
} from "./sessionCoordinatorTypes.js";

export interface SessionToolJobProcessorOptions {
  store: SessionStore;
  codexRunner: CodexRunner;
  cleanupCodexProcess: CodexProcessCleanup;
  runDeferredTool?: DeferredToolRunner;
  workerId: string;
  isStopped(): boolean;
  assertClaimUsable(state: SessionClaimState, signal: AbortSignal): void;
  scheduleTurns(): void;
  deferTurns(): void;
}

export class SessionToolJobProcessor {
  constructor(private readonly options: SessionToolJobProcessorOptions) {}

  async process(task: ClaimedToolTask, actorSignal: AbortSignal) {
    const { job, settings, state } = task;
    const signal = combineSignals(actorSignal, state.controller.signal);
    const attemptToken = requiredText(job.attemptToken, "tool job attemptToken");
    try {
      if (job.toolName !== "codex") {
        const runner = this.options.runDeferredTool;
        if (!runner) throw new Error(`Deferred tool runner is not configured for ${job.toolName}.`);
        const outcome = await runner(job, signal);
        this.options.assertClaimUsable(state, signal);
        this.options.store.completeToolJob({
          jobId: job.id,
          workerId: this.options.workerId,
          attempt: job.attempts,
          attemptToken,
          status: outcome.status,
          result: outcome.result,
          error: outcome.error
        });
        state.finalized = true;
        return;
      }
      if (job.processIdentity) {
        const cleanup = await this.options.cleanupCodexProcess(job.processIdentity);
        this.options.assertClaimUsable(state, signal);
        if (cleanup.status === "unverified") {
          this.options.store.completeToolJob({
            jobId: job.id,
            workerId: this.options.workerId,
            attempt: job.attempts,
            attemptToken,
            status: "unknown",
            error: {
              code: "orphan_process_unverified",
              message: cleanup.message ?? "Recovered Codex process identity could not be verified."
            }
          });
          state.finalized = true;
          return;
        }
        this.options.store.clearRecoveredToolJobProcess(
          job.id,
          this.options.workerId,
          job.attempts,
          attemptToken,
          job.processIdentity.runToken
        );
      }
      const result: CodexToolResult = await this.options.codexRunner.run(job.arguments as CodexToolInput, {
        jobId: job.id,
        jobDir: path.join(settings.jobRoot, job.id),
        workspacePath: settings.workspacePath,
        executable: settings.executable,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        authFile: settings.authFile,
        signal,
        attempt: job.attempts,
        runToken: attemptToken,
        onProcessStarted: (identity) => {
          this.options.store.recordToolJobProcess(
            job.id,
            this.options.workerId,
            job.attempts,
            attemptToken,
            identity
          );
        }
      });
      this.options.assertClaimUsable(state, signal);
      this.options.store.completeToolJob({
        jobId: job.id,
        workerId: this.options.workerId,
        attempt: job.attempts,
        attemptToken,
        status: result.status,
        result,
        error: result.ok ? undefined : result.error
      });
      state.finalized = true;
    } catch (error) {
      if (state.finalized || this.options.isStopped()) return;
      this.options.store.completeToolJob({
        jobId: job.id,
        workerId: this.options.workerId,
        attempt: job.attempts,
        attemptToken,
        status: signal.aborted ? "timed_out" : "failed",
        error: serializeError(error)
      });
      state.finalized = true;
    } finally {
      this.options.deferTurns();
    }
  }

  fail(job: ToolJobRecord, state: SessionClaimState, error: unknown) {
    if (state.finalized || this.options.isStopped()) return;
    state.finalized = true;
    try {
      this.options.store.completeToolJob({
        jobId: job.id,
        workerId: this.options.workerId,
        attempt: job.attempts,
        attemptToken: requiredText(job.attemptToken, "tool job attemptToken"),
        status: error instanceof SessionActorTaskTimeoutError ? "timed_out" : "failed",
        error: serializeError(error)
      });
      this.options.scheduleTurns();
    } catch {
      // A concurrent terminal write or recovery owns the final state.
    }
  }
}

function combineSignals(...signals: AbortSignal[]) {
  if (signals.length === 1) return signals[0]!;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof (error as NodeJS.ErrnoException).code === "string"
        ? { code: (error as NodeJS.ErrnoException).code }
        : {})
    };
  }
  return { message: String(error) };
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
