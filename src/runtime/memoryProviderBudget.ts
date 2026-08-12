import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";
import {
  AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS,
  type ProviderLogContext
} from "../../packages/contracts/model/modelGateway.js";

export const MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS = AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS;
export const MEMORY_PROVIDER_TOTAL_TIMEOUT_MS = AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS;

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
