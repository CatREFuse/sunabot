import {
  computeMemoryEventFingerprint,
  normalizeText,
  sha256
} from "../domain/normalizers.js";
import type { DreamMemoryRecord } from "./consolidation.js";
import type { DreamMinimalModelOutput } from "./types.js";

export interface DreamMinimalConsolidationInput {
  runId: string;
  localDate: string;
  scheduledFor: string;
  seed: string;
  now: Date;
  output: DreamMinimalModelOutput;
  workingRecords: readonly DreamMemoryRecord[];
  longTermRecords: readonly DreamMemoryRecord[];
}

export interface DreamMinimalConsolidationPlan {
  workingMemoryId: null;
  workingMemoryCompression: string;
  working: DreamMemoryRecord[];
  longTerm: DreamMemoryRecord[];
  result: {
    schemaVersion: 2;
    workingMemoryCompression: {
      sourceCount: number;
      outputCount: number;
      reducedBy: number;
      unavailable: number;
    };
    longTermMemoryAdditions: {
      requested: number;
      added: number;
      duplicate: number;
      unavailable: number;
    };
  };
}

export function buildDreamMinimalConsolidationPlan(
  input: DreamMinimalConsolidationInput
): DreamMinimalConsolidationPlan {
  const now = validDate(input.now).toISOString();
  const working = input.workingRecords.map((record) => structuredClone(record));
  const longTerm = recordMap(input.longTermRecords, "long_term");
  const existingFingerprints = new Set(
    [...longTerm.values()].flatMap((record) => {
      const fingerprint = normalizeText(record.eventFingerprint);
      return fingerprint ? [fingerprint] : [];
    })
  );
  const existingFacts = new Set(
    [...longTerm.values()].map((record) => comparableFact(record.fact)).filter(Boolean)
  );
  let added = 0;
  let duplicate = 0;

  for (const fact of input.output.longTermMemoryAdditions) {
    const id = minimalLongTermId(fact);
    const record = dreamLongTermRecord(id, fact, input.runId, now);
    const fingerprint = normalizeText(record.eventFingerprint);
    const comparable = comparableFact(record.fact);
    if (
      longTerm.has(id)
      || (fingerprint && existingFingerprints.has(fingerprint))
      || (comparable && existingFacts.has(comparable))
    ) {
      duplicate += 1;
      continue;
    }
    longTerm.set(id, record);
    if (fingerprint) existingFingerprints.add(fingerprint);
    if (comparable) existingFacts.add(comparable);
    added += 1;
  }

  const sourceCount = input.workingRecords.length;
  const outputCount = input.output.workingMemoryCompression.trim() ? 1 : 0;
  return {
    workingMemoryId: null,
    workingMemoryCompression: input.output.workingMemoryCompression,
    working,
    longTerm: [...longTerm.values()],
    result: {
      schemaVersion: 2,
      workingMemoryCompression: {
        sourceCount,
        outputCount,
        reducedBy: Math.max(0, sourceCount - outputCount),
        unavailable: 0
      },
      longTermMemoryAdditions: {
        requested: input.output.longTermMemoryAdditions.length,
        added,
        duplicate,
        unavailable: 0
      }
    }
  };
}

function dreamLongTermRecord(
  id: string,
  fact: string,
  runId: string,
  now: string
): DreamMemoryRecord {
  return {
    schemaVersion: 2,
    id,
    fact,
    source: "sunabot.dream",
    sourceWorkingMemoryIds: [],
    factuality: "factual",
    realityStatus: "factual",
    createdAt: now,
    updatedAt: now,
    dreamRunId: runId,
    consolidatedBy: "sunabot.dream",
    eventFingerprint: computeMemoryEventFingerprint({
      fact,
      userIds: [],
      occurredAt: null,
      occurredEndAt: null
    })
  };
}

function minimalLongTermId(fact: string) {
  return `long_term_${sha256(comparableFact(fact)).slice(0, 32)}`;
}

function comparableFact(value: unknown) {
  return normalizeText(value).normalize("NFC").replace(/\s+/gu, " ").toLocaleLowerCase();
}

function recordMap(records: readonly DreamMemoryRecord[], source: string) {
  const result = new Map<string, DreamMemoryRecord>();
  for (const record of records) {
    const id = normalizeText(record.id);
    if (!id) throw new Error("Dream consolidation requires stable memory ids.");
    if (result.has(id)) throw new Error(`Duplicate ${source} memory id ${id}.`);
    result.set(id, structuredClone(record));
  }
  return result;
}

function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Dream consolidation time is invalid.");
  }
  return value;
}
