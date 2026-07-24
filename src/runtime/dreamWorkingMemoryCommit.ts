import type { DreamMemoryRecord } from "../../services/memory/dream/public.js";

export interface RuntimeDreamWorkingMemoryPort {
  compareAndSwap(input: {
    expectedRevision: string;
    records: readonly DreamMemoryRecord[];
    runId: string;
    localDate: string;
  }): Promise<
    | { status: "updated" | "unchanged"; revision: string; rollback: () => Promise<boolean> }
    | { status: "conflict"; revision: string }
  >;
}

export async function commitDreamWithWorkingMemory<T extends { status: string }>(input: {
  workingMemory?: RuntimeDreamWorkingMemoryPort;
  workingRevision?: string;
  records: readonly DreamMemoryRecord[];
  runId: string;
  localDate: string;
  commit(externalWorkingMemory: boolean): T;
}) {
  const workingCommit = input.workingMemory && input.workingRevision
    ? await input.workingMemory.compareAndSwap({
        expectedRevision: input.workingRevision,
        records: input.records,
        runId: input.runId,
        localDate: input.localDate
      })
    : undefined;
  if (workingCommit?.status === "conflict") {
    throw dreamCommitError("DREAM_SNAPSHOT_CONFLICT", "Dream memory snapshot changed: working.");
  }
  let committed: T;
  try {
    committed = input.commit(workingCommit != null);
  } catch (error) {
    await rollbackOrThrow(workingCommit);
    throw error;
  }
  if (committed.status !== "committed" && committed.status !== "existing") {
    await rollbackOrThrow(workingCommit);
  }
  return committed;
}

async function rollbackOrThrow(
  commit: Exclude<Awaited<ReturnType<RuntimeDreamWorkingMemoryPort["compareAndSwap"]>>, { status: "conflict" }> | undefined
) {
  if (!commit || await commit.rollback()) return;
  throw dreamCommitError(
    "DREAM_WORKING_MEMORY_ROLLBACK_CONFLICT",
    "Dream working-memory rollback conflicted."
  );
}

function dreamCommitError(code: string, message: string) {
  return Object.assign(new Error(message), { code, retryable: false });
}
