import { OpenAIProvider, type ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import {
  runBashAudit,
  type BashAuditInput
} from "../../services/tools/bashAudit.js";
import type { RuntimeBashAuditPort } from "../../src/runtime/runtimeContracts.js";
import type { AppConfig, ProviderConfig } from "../../packages/contracts/admin/public.js";
import { auxiliaryProviderCompleteOptions } from "../../src/runtime/auxiliaryModelBudget.js";

interface BashAuditProviderPort {
  hasApiKey(): boolean;
  completeRequest(request: RenderedPromptRequest, options?: ProviderCompleteOptions): Promise<string>;
}

export interface BashAuditRuntimeOptions {
  createProvider?(provider: ProviderConfig): BashAuditProviderPort;
}

export function createBashAuditRuntimePort(
  options: BashAuditRuntimeOptions = {}
): RuntimeBashAuditPort {
  const createProvider = options.createProvider ?? ((provider) => new OpenAIProvider(provider));
  return {
    async available(config) {
      const providerConfig = bashAuditProviderConfig(config);
      if (!providerConfig) return false;
      try {
        return createProvider(providerConfig).hasApiKey();
      } catch {
        return false;
      }
    },
    async run(config, input) {
      const providerConfig = bashAuditProviderConfig(config);
      if (!providerConfig) throw new Error("BASH_AUDIT_UNAVAILABLE");
      let provider: BashAuditProviderPort;
      try {
        provider = createProvider(providerConfig);
        if (!provider.hasApiKey()) throw new Error("BASH_AUDIT_UNAVAILABLE");
      } catch {
        throw new Error("BASH_AUDIT_UNAVAILABLE");
      }
      return runBashAudit(input, (request) => provider.completeRequest(
        request as unknown as RenderedPromptRequest,
        bashAuditRequestOptions(input)
      ));
    }
  };
}

function bashAuditProviderConfig(config: AppConfig): ProviderConfig | undefined {
  const model = config.bot.bash.auditModel.trim();
  const provider = config.providers.items.find(
    (candidate) => candidate.id === config.providers.defaultProviderId
  );
  if (!provider?.enabled || !model) return undefined;
  return {
    ...provider,
    id: `${provider.id}:bash-audit`,
    model
  };
}

function bashAuditRequestOptions(input: BashAuditInput): ProviderCompleteOptions {
  return auxiliaryProviderCompleteOptions({
    ...(input.signal ? { signal: input.signal } : {}),
    modelRequestMaxRetries: 0,
    logContext: { stage: "bash_audit", promptFamily: "bash_audit" }
  });
}
