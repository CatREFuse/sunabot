import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { memoryRepository } from "./persistence.js";

export const MEMORY_PROCESSING_HEALTH_WINDOW_HOURS = 24;
const MEMORY_PROCESSING_HEALTH_WINDOW_MS = MEMORY_PROCESSING_HEALTH_WINDOW_HOURS * 60 * 60 * 1_000;

export interface MemoryProcessingHealth {
  windowHours: typeof MEMORY_PROCESSING_HEALTH_WINDOW_HOURS;
  windowStartedAt: string;
  measuredAt: string;
  successful: number;
  attempted: number;
  pending: number;
}

export function readMemoryProcessingHealth(
  config: Pick<AppConfig, "persona">,
  input: { pending: number; measuredAt?: Date }
): MemoryProcessingHealth {
  const measuredAt = input.measuredAt ?? new Date();
  const measuredAtMs = measuredAt.getTime();
  if (!Number.isFinite(measuredAtMs)) throw new Error("Memory processing health time is invalid.");
  if (!Number.isSafeInteger(input.pending) || input.pending < 0) {
    throw new Error("Memory processing pending count is invalid.");
  }
  const windowStartedAt = new Date(measuredAtMs - MEMORY_PROCESSING_HEALTH_WINDOW_MS);
  const repository = memoryRepository(config);
  if (!repository.readMemoryProcessingAttemptCounts) {
    throw new Error("Memory processing health reader is unavailable.");
  }
  const counts = repository.readMemoryProcessingAttemptCounts({
    since: windowStartedAt.toISOString(),
    until: measuredAt.toISOString()
  });
  return {
    windowHours: MEMORY_PROCESSING_HEALTH_WINDOW_HOURS,
    windowStartedAt: windowStartedAt.toISOString(),
    measuredAt: measuredAt.toISOString(),
    successful: counts.successful,
    attempted: counts.attempted,
    pending: input.pending
  };
}
