import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";

export function auxiliaryModelSignal(parent?: AbortSignal) {
  return parent ?? AbortSignal.timeout(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
}

export function auxiliaryProviderCompleteOptions(
  options: ProviderCompleteOptions = {}
): ProviderCompleteOptions {
  return {
    ...options,
    signal: auxiliaryModelSignal(options.signal),
    modelRequestAttemptTimeoutMs: AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS
  };
}
