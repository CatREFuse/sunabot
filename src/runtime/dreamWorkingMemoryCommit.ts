import type { DreamMemoryRecord } from "../../services/memory/dream/public.js";

export interface RuntimeDreamWorkingMemoryPort {
  compareAndSwap(input: {
    expectedRevision: string;
    records: readonly DreamMemoryRecord[];
    runId: string;
    localDate: string;
    signal?: AbortSignal;
  }): Promise<
    | { status: "updated" | "unchanged"; revision: string; rollback: () => Promise<boolean> }
    | { status: "conflict"; revision: string }
  >;
}

export interface RuntimeDreamFieldKnowledgePort {
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
  records: readonly DreamMemoryRecord[];
  fieldKnowledge?: RuntimeDreamFieldKnowledgePort;
  fieldKnowledgeRevision?: string;
  fieldKnowledgeContent?: string | null;
  runId: string;
  localDate: string;
  signal?: AbortSignal;
  commit(externalWorkingMemory: boolean, fieldKnowledgeUpdated: boolean): T;
}) {
  input.signal?.throwIfAborted();
  const workingCommit = input.workingMemory && input.workingRevision
    ? await input.workingMemory.compareAndSwap({
        expectedRevision: input.workingRevision,
        records: input.records,
        runId: input.runId,
        localDate: input.localDate,
        signal: input.signal
      })
    : undefined;
  if (input.signal?.aborted) {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
    throw input.signal.reason ?? new Error("Dream commit aborted.");
  }
  if (workingCommit?.status === "conflict") {
    throw dreamCommitError("DREAM_SNAPSHOT_CONFLICT", "Dream memory snapshot changed: working.");
  }
  let fieldKnowledgeCommit: Awaited<
    ReturnType<RuntimeDreamFieldKnowledgePort["compareAndSwap"]>
  > | undefined;
  try {
    fieldKnowledgeCommit = input.fieldKnowledge
      && input.fieldKnowledgeRevision
      && input.fieldKnowledgeContent
      ? await input.fieldKnowledge.compareAndSwap({
          expectedRevision: input.fieldKnowledgeRevision,
          content: input.fieldKnowledgeContent,
          runId: input.runId,
          localDate: input.localDate,
          signal: input.signal
        })
      : undefined;
  } catch (error) {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
    throw error;
  }
  if (input.signal?.aborted) {
    await rollbackExternalCommits([
      { commit: fieldKnowledgeCommit, source: "field_knowledge" },
      { commit: workingCommit, source: "working" }
    ]);
    throw input.signal.reason ?? new Error("Dream commit aborted.");
  }
  if (fieldKnowledgeCommit?.status === "conflict") {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
    throw dreamCommitError(
      "DREAM_SNAPSHOT_CONFLICT",
      "Dream memory snapshot changed: field_knowledge."
    );
  }
  const fieldKnowledgeUpdated = fieldKnowledgeCommit?.status === "updated";
  let committed: T;
  try {
    input.signal?.throwIfAborted();
    committed = input.commit(workingCommit != null, fieldKnowledgeUpdated);
  } catch (error) {
    await rollbackExternalCommits([
      { commit: fieldKnowledgeCommit, source: "field_knowledge" },
      { commit: workingCommit, source: "working" }
    ]);
    throw error;
  }
  if (committed.status !== "committed" && committed.status !== "existing") {
    await rollbackExternalCommits([
      { commit: fieldKnowledgeCommit, source: "field_knowledge" },
      { commit: workingCommit, source: "working" }
    ]);
  }
  return { committed, fieldKnowledgeUpdated };
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
        value.source === "working"
          ? "DREAM_WORKING_MEMORY_ROLLBACK_CONFLICT"
          : "DREAM_FIELD_KNOWLEDGE_ROLLBACK_CONFLICT",
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
