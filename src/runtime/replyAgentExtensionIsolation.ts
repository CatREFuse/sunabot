import type {
  PreparedRuntimeAgentExtensions,
  RuntimeAgentExtensionsPort
} from "./agentExtensions.js";
import { parseExplicitSkillSelections } from "./agentExtensions.js";
import { isolateReplyModule } from "./replyModuleIsolation.js";

export async function prepareReplyAgentExtensions(
  port: RuntimeAgentExtensionsPort | undefined,
  input: Parameters<RuntimeAgentExtensionsPort["prepare"]>[0],
  batchTexts: readonly string[]
): Promise<{
  prepared?: PreparedRuntimeAgentExtensions;
  softErrors: string[];
}> {
  const selectedSkillIds = parseExplicitSkillSelections(batchTexts);
  const softErrors: string[] = [];
  if (!port) return { softErrors };
  const prepared = await isolateReplyModule(
    "agent_extensions",
    () => port.prepare({ ...input, selectedSkillIds }),
    () => undefined,
    {
      signal: input.signal,
      onFailure: () => {
        if (selectedSkillIds.length) {
          softErrors.push("Agent 扩展正在更新，所选 Skill 暂不可用");
        }
      }
    }
  );
  const requestedMcpUnavailable = prepared?.requiredMcpFailures.some((serverId) =>
    batchTexts.some((text) => text.toLocaleLowerCase().includes(serverId.toLocaleLowerCase()))
  );
  if (requestedMcpUnavailable) softErrors.push("请求使用的 MCP 服务暂不可用");
  return { prepared, softErrors };
}
