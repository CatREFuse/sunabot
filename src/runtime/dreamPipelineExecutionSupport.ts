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
  if (typeof payload.workingMemory !== "string") {
    throw new DreamRunError("DREAM_INPUT_INVALID", "workingMemory is invalid.", false);
  }
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
  const value = payload.longTermMemories;
  if (!Array.isArray(value)) {
    throw new DreamRunError("DREAM_INPUT_INVALID", "longTermMemories is invalid.", false);
  }
  return value.map((item, index) => {
    if (!isDreamPipelineObject(item) || !isDreamPipelineObject(item.memory)) {
      throw new DreamRunError("DREAM_INPUT_INVALID", `longTermMemories[${index}] is invalid.`, false);
    }
    return item.memory;
  });
}
