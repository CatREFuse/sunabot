import type {
  BashAuditInput,
  BashAuditResult,
  BashAuditRunner
} from "./bashAudit.js";

export const WORKSPACE_BASH_AUDIT_TIMEOUT_MS = 10_000;

export function runBashAuditWithDeadline(
  audit: BashAuditRunner,
  input: Omit<BashAuditInput, "signal">,
  callerSignal?: AbortSignal
): Promise<BashAuditResult> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let completed = false;
    let callerAbort: (() => void) | undefined;
    const finish = (error: unknown, result?: BashAuditResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (callerAbort && callerSignal) callerSignal.removeEventListener("abort", callerAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      controller.abort(new Error("BASH_AUDIT_TIMEOUT"));
      finish(new Error("BASH_AUDIT_TIMEOUT"));
    }, WORKSPACE_BASH_AUDIT_TIMEOUT_MS);
    timer.unref();
    if (callerSignal) {
      callerAbort = () => {
        controller.abort(callerSignal.reason);
        finish(new Error("BASH_AUDIT_ABORTED"));
      };
      callerSignal.addEventListener("abort", callerAbort, { once: true });
      if (callerSignal.aborted) {
        callerAbort();
        return;
      }
    }
    try {
      void audit({ ...input, signal: controller.signal }).then(
        (result) => finish(undefined, result),
        (error) => finish(error)
      );
    } catch (error) {
      finish(error);
    }
  });
}
