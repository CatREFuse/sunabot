import type { ProviderConfig } from "../../../src/types.js";
import { appendRequestLog } from "../../../src/requestLog.js";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import {
  ImageGenerationHttpError,
  imageGenerationErrorCode,
  imageGenerationErrorStatus
} from "../imageGenerationRetry.js";
import type { ProviderLoggerPort } from "./contracts.js";
import { projectProviderRequestLogForStorage } from "./requestLogProjection.js";
import { errorMessage } from "./valueUtils.js";

export function createProviderLogger(provider: ProviderConfig): ProviderLoggerPort {
  const response: ProviderLoggerPort["response"] = async (action, payload, metadata = {}) => {
    await appendRequestLog({
      category: "model.response",
      action,
      providerId: provider.id,
      providerKind: provider.kind,
      model: provider.model,
      response: payload,
      metadata
    });
  };

  return {
    async request(action, request, metadata = {}) {
      await appendRequestLog({
        category: "model.request",
        action,
        providerId: provider.id,
        providerKind: provider.kind,
        model: provider.model,
        request: projectProviderRequestLogForStorage(action, request),
        metadata
      });
    },
    response,
    async imageAttemptFailure(action, error, context, metadata) {
      const status = imageGenerationErrorStatus(error);
      const errorCode = imageGenerationErrorCode(error);
      const responseSummary = error instanceof ImageGenerationHttpError ? error.responseSummary : undefined;
      await response(action, {
        ok: false,
        ...(status == null ? {} : { status }),
        error: errorMessage(error),
        ...(responseSummary == null ? {} : { summary: responseSummary }),
        willRetry: context.willRetry,
        retryDelayMs: context.retryDelayMs,
        ...(errorCode ? { errorCode } : {})
      }, {
        ...metadata,
        attempt: context.attempt,
        maxAttempts: context.maxAttempts
      });
    }
  };
}

export function withLogContext(metadata: Record<string, unknown>, context?: ProviderLogContext) {
  return context ? { ...metadata, ...context } : metadata;
}

export function logContextMetadata(context?: ProviderLogContext): Record<string, unknown> | undefined {
  return context ? { ...context } : undefined;
}
