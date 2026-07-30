import path from "node:path";
import type {
  CodexRunner,
  CodexTaskStatus,
  CodexToolInput,
  CodexToolResult
} from "../../packages/contracts/tools/codex.js";
import { SessionActorTaskTimeoutError } from "./sessionActor.js";
import {
  codexResultSensitivePaths,
  sanitizeCodexArtifactError
} from "./codexResultSanitizer.js";
import type { SessionStore, ToolJobRecord } from "./sessionStore.js";
import type {
  ClaimedToolTask,
  CodexProcessCleanup,
  CodexResultFinalization,
  CodexResultFinalizer,
  CodexToolUsageObserver,
  DeferredToolRunner,
  SessionClaimState
} from "./sessionCoordinatorTypes.js";

export interface SessionToolJobProcessorOptions {
  store: SessionStore;
  codexRunner: CodexRunner;
  cleanupCodexProcess: CodexProcessCleanup;
  runDeferredTool?: DeferredToolRunner;
  finalizeCodexResult?: CodexResultFinalizer;
  observeCodexToolUsage?: CodexToolUsageObserver;
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
    let codexProcessStarted = false;
    let codexAttemptResult: CodexToolResult | undefined;
    let stagedFinalization: CodexResultFinalization | undefined;
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
      const runnerResult: CodexToolResult = await this.options.codexRunner.run(job.arguments as CodexToolInput, {
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
          codexProcessStarted = true;
          this.options.store.recordToolJobProcess(
            job.id,
            this.options.workerId,
            job.attempts,
            attemptToken,
            identity
          );
        }
      });
      codexAttemptResult = runnerResult;
      this.options.assertClaimUsable(state, signal);
      let result = runnerResult;
      try {
        if (this.options.finalizeCodexResult) {
          stagedFinalization = await this.options.finalizeCodexResult({
            job,
            settings,
            result: runnerResult,
            signal
          });
          result = stagedFinalization.result;
        } else if (runnerResult.artifacts?.length) {
          throw Object.assign(new Error("Codex artifact finalizer is not configured."), {
            code: "codex_artifact_finalizer_unavailable"
          });
        }
      } catch (error) {
        const sensitivePaths = await codexResultSensitivePaths({
          job,
          settings,
          resultFile: runnerResult.resultFile
        });
        const finalizationError = sanitizeCodexArtifactError(error, sensitivePaths);
        codexAttemptResult = codexArtifactFailureResult(runnerResult, finalizationError);
        throw finalizationError;
      }
      codexAttemptResult = result;
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
      stagedFinalization?.commit();
      stagedFinalization = undefined;
      state.finalized = true;
    } catch (error) {
      let terminalError = error;
      let rollbackFailed = false;
      if (stagedFinalization) {
        try {
          await stagedFinalization.rollback();
        } catch {
          rollbackFailed = true;
          terminalError = Object.assign(
            new Error("codex_artifact_rollback_failed"),
            { code: "codex_artifact_rollback_failed" }
          );
          if (codexAttemptResult) {
            codexAttemptResult = codexArtifactFailureResult(
              codexAttemptResult,
              terminalError
            );
          }
        }
      }
      stagedFinalization = undefined;
      const status: CodexTaskStatus = rollbackFailed
        ? "failed"
        : signal.aborted ? "timed_out" : "failed";
      if (job.toolName === "codex" && codexProcessStarted && !codexAttemptResult) {
        codexAttemptResult = {
          ok: false,
          status,
          jobId: job.id,
          kind: "analysis",
          error: {
            code: "worker_failed",
            message: terminalError instanceof Error
              ? terminalError.message
              : String(terminalError)
          }
        };
      }
      if (state.finalized || this.options.isStopped()) return;
      this.options.store.completeToolJob({
        jobId: job.id,
        workerId: this.options.workerId,
        attempt: job.attempts,
        attemptToken,
        status,
        error: serializeError(terminalError)
      });
      state.finalized = true;
    } finally {
      if (codexAttemptResult && (codexProcessStarted || codexAttemptResult.usage)) {
        await this.observeCodexToolUsage(job, settings.model, codexAttemptResult);
      }
      this.options.deferTurns();
    }
  }

  private async observeCodexToolUsage(job: ToolJobRecord, model: string | undefined, result: CodexToolResult) {
    if (!this.options.observeCodexToolUsage) return;
    try {
      await this.options.observeCodexToolUsage({
        jobId: job.id,
        conversationId: job.sessionId,
        attempt: job.attempts,
        model,
        ok: result.ok,
        status: result.status,
        ...(result.usage ? { usage: { ...result.usage } } : {})
      });
    } catch {
      // Observability must not change a durable tool-job terminal state.
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

function codexArtifactFailureResult(
  result: CodexToolResult,
  error: unknown
): CodexToolResult {
  return {
    ...result,
    ok: false,
    status: "failed",
    artifacts: undefined,
    error: {
      code: typeof (error as { code?: unknown } | undefined)?.code === "string"
        ? String((error as { code: string }).code)
        : "codex_artifact_publish_failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: false
    }
  };
}
