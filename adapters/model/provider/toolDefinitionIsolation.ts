import { assertProviderToolDefinition } from "../../../services/tools/providerToolSchema.js";
import { errorMessage } from "./valueUtils.js";
import { readToolName } from "./promptMapping.js";

export function validProviderToolDefinitions(
  definitions: readonly Record<string, unknown>[]
) {
  return definitions.filter((definition) => {
    try {
      assertProviderToolDefinition(definition);
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
