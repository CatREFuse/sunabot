import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";

export const MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS = 120_000;
export const MEMORY_PROVIDER_TOTAL_TIMEOUT_MS = 135_000;

export function memoryProviderCompleteOptions(
  signal: AbortSignal,
  logContext: ProviderLogContext
): ProviderCompleteOptions {
  return {
    signal,
    modelRequestMaxRetries: 0,
    modelRequestAttemptTimeoutMs: MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS,
    logContext
  };
}
