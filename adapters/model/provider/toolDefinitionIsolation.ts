import {
  assertProviderToolDefinition,
  type ProviderToolSchemaProtocol
} from "../../../services/tools/providerToolSchema.js";
import { errorMessage } from "./valueUtils.js";
import { readToolName } from "./promptMapping.js";

export function validProviderToolDefinitions(
  definitions: readonly Record<string, unknown>[],
  protocol: ProviderToolSchemaProtocol = "openai-responses"
) {
  return definitions.filter((definition) => {
    try {
      assertProviderToolDefinition(definition, protocol);
      return true;
    } catch (error) {
      console.error("[provider] invalid tool definition quarantined", {
        tool: readToolName(definition) || "<unnamed>",
        error: errorMessage(error)
      });
      return false;
    }
  });
}
