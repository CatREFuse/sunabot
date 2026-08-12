export interface RuntimeDreamWorkingMemoryPort {
  compareAndSwap(input: {
    expectedRevision: string;
    content: string;
    runId: string;
    localDate: string;
    signal?: AbortSignal;
  }): Promise<
    | { status: "updated" | "unchanged"; revision: string; rollback: () => Promise<boolean> }
    | { status: "conflict"; revision: string }
  >;
}

export async function commitDreamWithWorkingMemory<T extends { status: string }>(input: {
  workingMemory?: RuntimeDreamWorkingMemoryPort;
  workingRevision?: string;
  content: string;
  runId: string;
  localDate: string;
  signal?: AbortSignal;
  commit(externalWorkingMemory: boolean): T;
}) {
  input.signal?.throwIfAborted();
  const workingCommit = input.workingMemory && input.workingRevision
    ? await input.workingMemory.compareAndSwap({
        expectedRevision: input.workingRevision,
        content: input.content,
        runId: input.runId,
        localDate: input.localDate,
        signal: input.signal
      })
    : undefined;
  if (input.signal?.aborted) {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
    throw input.signal.reason ?? new Error("Dream commit aborted.");
  }
  let committed: T;
  try {
    input.signal?.throwIfAborted();
    committed = input.commit(input.workingMemory != null && input.workingRevision != null);
  } catch (error) {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
    throw error;
  }
  if (committed.status !== "committed" && committed.status !== "existing") {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
  }
  return {
    committed,
    workingMemoryUpdated: workingCommit?.status === "updated"
  };
}

type ExternalCommit = {
  status: "updated" | "unchanged";
  revision: string;
  rollback: () => Promise<boolean>;
};

async function rollbackExternalCommits(
  values: Array<{ commit: ExternalCommit | { status: "conflict"; revision: string } | undefined; source: string }>
) {
  let rollbackFailure: Error | undefined;
  for (const value of values) {
    if (!value.commit || value.commit.status === "conflict") continue;
    try {
      if (await value.commit.rollback()) continue;
      rollbackFailure ??= dreamCommitError(
        "DREAM_WORKING_MEMORY_ROLLBACK_CONFLICT",
        `Dream ${value.source.replaceAll("_", "-")} rollback conflicted.`
      );
    } catch (error) {
      rollbackFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (rollbackFailure) throw rollbackFailure;
}

function dreamCommitError(code: string, message: string) {
  return Object.assign(new Error(message), { code, retryable: false });
}
