import type { DreamRecallStatsSnapshot } from "../../services/memory/dream/public.js";
import {
  isDreamPipelineObject,
  type DreamPipelineJsonObject
} from "./dreamPipelineSupport.js";

export class DreamRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true
  ) {
    super(message);
  }
}

export function combineDreamPipelineSignals(...signals: Array<AbortSignal | undefined>) {
  const values = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!values.length) return undefined;
  return values.length === 1 ? values[0] : AbortSignal.any(values);
}

export function dreamPipelineModelExpectations(payload: DreamPipelineJsonObject) {
  return {
    workingMemoryIds: promptMemoryIds(payload.workingMemories, "workingMemories"),
    longTermMemoryIds: promptMemoryIds(payload.longTermMemories, "longTermMemories"),
    personaEvidenceIds: stringArray(payload.personaEvidenceIds, "personaEvidenceIds"),
    fieldKnowledgeEvidenceIds: stringArray(
      payload.fieldKnowledgeEvidenceIds ?? [],
      "fieldKnowledgeEvidenceIds"
    ),
    fieldKnowledgeWritable: payload.fieldKnowledgeWritable === true
  };
}

export function dreamPipelineRecentWindowHours(payload: DreamPipelineJsonObject) {
  const value = payload.recentWindowHours;
  if (value == null) return 48;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 720) {
    throw new DreamRunError("DREAM_INPUT_INVALID", "recentWindowHours is invalid.", false);
  }
  return Number(value);
}

export function dreamPipelineRecallStats(
  payload: DreamPipelineJsonObject
): DreamRecallStatsSnapshot[] {
  if (!Array.isArray(payload.recallStats)) {
    throw new DreamRunError("DREAM_INPUT_INVALID", "recallStats is invalid.", false);
  }
  return payload.recallStats as DreamRecallStatsSnapshot[];
}

export function dreamPipelinePromptRecords(payload: DreamPipelineJsonObject) {
  return [payload.workingMemories, payload.longTermMemories].flatMap((value, groupIndex) => {
    if (!Array.isArray(value)) {
      throw new DreamRunError("DREAM_INPUT_INVALID", `memory group ${groupIndex} is invalid.`, false);
    }
    return value.map((item, index) => {
      if (!isDreamPipelineObject(item) || !isDreamPipelineObject(item.memory)) {
        throw new DreamRunError("DREAM_INPUT_INVALID", `memory group ${groupIndex}[${index}] is invalid.`, false);
      }
      return item.memory;
    });
  });
}

function promptMemoryIds(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new DreamRunError("DREAM_INPUT_INVALID", `${field} is invalid.`, false);
  return value.map((item, index) => {
    if (!isDreamPipelineObject(item) || typeof item.id !== "string") {
      throw new DreamRunError("DREAM_INPUT_INVALID", `${field}[${index}] is invalid.`, false);
    }
    return item.id;
  });
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DreamRunError("DREAM_INPUT_INVALID", `${field} is invalid.`, false);
  }
  return value as string[];
}
