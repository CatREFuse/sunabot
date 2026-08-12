import {
  parseStoredDreamPersonaImpression,
  renderActiveDreamPersonaImpressions,
  resolveDreamPersonaImpressions,
  type DreamPersonaAdjustmentV1,
  type DreamPersonaImpressionLevel,
  type DreamPersonaImpressionRecord
} from "../../services/memory/dream/public.js";

interface DreamPersonaHistoryRun {
  id: string;
  localDate: string;
  personaStatus: string;
  personaUpdatedAt: string | null;
  persona: Record<string, unknown> | null;
}

export interface RuntimeDreamPersonaHistoryPort {
  listRuns(input?: { beforeLocalDate?: string; limit?: number }): DreamPersonaHistoryRun[];
}

export interface RuntimeDreamPersonaProjectionPort {
  read(
    id: "persona.preference" | "persona.relation",
    signal?: AbortSignal
  ): Promise<{ content: string; revision: string }>;
  compareAndSwap(input: {
    id: "persona.preference" | "persona.relation";
    revision: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export function activeDreamPersonaImpressionCatalog(store: RuntimeDreamPersonaHistoryPort) {
  return resolveDreamPersonaImpressions(appliedDreamPersonaImpressions(store)).active.map((record) => ({
    id: record.id,
    appliedAt: record.appliedAt,
    kind: record.impression.kind,
    targetFile: record.impression.targetFile,
    topicKey: record.impression.topicKey,
    level: record.impression.level,
    statement: record.impression.statement
  }));
}

export async function applyDreamPersonaImpressionProjection(input: {
  store: RuntimeDreamPersonaHistoryPort;
  persona: RuntimeDreamPersonaProjectionPort;
  adjustment: DreamPersonaAdjustmentV1;
  level: DreamPersonaImpressionLevel;
  runId: string;
  appliedAt: string;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const impression = { ...input.adjustment, level: input.level };
  const retained = [
    ...appliedDreamPersonaImpressions(input.store),
    { id: input.runId, appliedAt: input.appliedAt, impression }
  ];
  const resolution = resolveDreamPersonaImpressions(retained);
  const id = input.adjustment.targetFile === "PREFERENCE.md"
    ? "persona.preference" as const
    : "persona.relation" as const;
  const current = await input.persona.read(id, input.signal);
  input.signal?.throwIfAborted();
  const next = renderActiveDreamPersonaImpressions(current.content, retained, input.adjustment.targetFile);
  if (next !== current.content) {
    await input.persona.compareAndSwap({
      id,
      revision: current.revision,
      content: next,
      signal: input.signal
    });
    input.signal?.throwIfAborted();
  }
  const covered = resolution.covered.find((item) => item.id === input.runId);
  return {
    impression,
    effective: !covered,
    ...(covered ? { coveredBy: covered.coveredBy } : {}),
    projectionChanged: next !== current.content
  };
}

export function appliedDreamPersonaImpressions(
  store: RuntimeDreamPersonaHistoryPort
): DreamPersonaImpressionRecord[] {
  const records: DreamPersonaImpressionRecord[] = [];
  let beforeLocalDate: string | undefined;
  while (true) {
    const page = store.listRuns({ ...(beforeLocalDate ? { beforeLocalDate } : {}), limit: 100 });
    for (const run of page) {
      if (run.personaStatus !== "applied" || !run.personaUpdatedAt || !run.persona) continue;
      const value = isObject(run.persona.impression)
        ? run.persona.impression
        : run.persona.adjustment;
      const impression = parseStoredDreamPersonaImpression(value);
      if (impression) records.push({ id: run.id, appliedAt: run.personaUpdatedAt, impression });
    }
    if (page.length < 100) break;
    const nextBefore = page.at(-1)?.localDate;
    if (!nextBefore || nextBefore === beforeLocalDate) break;
    beforeLocalDate = nextBefore;
  }
  return records.reverse();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
