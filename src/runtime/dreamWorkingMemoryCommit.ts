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

export interface RuntimeDreamFieldKnowledgePort {
  compareAndSwap(input: {
    expectedRevision: string;
    content: string;
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
  fieldKnowledge?: RuntimeDreamFieldKnowledgePort;
  fieldKnowledgeRevision?: string;
  fieldKnowledgeContent?: string | null;
  runId: string;
  localDate: string;
  commit(externalWorkingMemory: boolean, fieldKnowledgeUpdated: boolean): T;
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
          localDate: input.localDate
        })
      : undefined;
  } catch (error) {
    await rollbackExternalCommits([{ commit: workingCommit, source: "working" }]);
    throw error;
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
