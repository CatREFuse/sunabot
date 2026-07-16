import type { ProviderWorkbenchFileOptions } from "../../adapters/model/provider/contracts.js";
import type { InboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import { isAdminSender } from "../../services/messaging/replySenderPolicy.js";
import { createWorkbenchFileToolPort } from "../../services/tools/public.js";
import { resolveProjectPath } from "../config.js";
import type { AppConfig } from "../types.js";

export function providerWorkbenchFilesForIncoming(
  config: AppConfig,
  incoming: InboundMessageV1,
  promptOverride: string | undefined
): ProviderWorkbenchFileOptions | undefined {
  const adminQq = config.bot.adminQq.trim();
  if (
    promptOverride !== undefined
    || incoming.transport !== undefined
    || incoming.scope !== "private"
    || incoming.groupId !== undefined
    || incoming.agentId !== config.persona.defaultAgentId
    || !incoming.accountId?.trim()
    || !Number.isSafeInteger(incoming.messageId)
    || Number(incoming.messageId) <= 0
    || !Number.isSafeInteger(incoming.selfId)
    || Number(incoming.selfId) <= 0
    || !adminQq
    || !isAdminSender(incoming.userId, adminQq)
  ) {
    return undefined;
  }
  const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
  return agentWorkspace ? createWorkbenchFileToolPort(agentWorkspace) : undefined;
}
