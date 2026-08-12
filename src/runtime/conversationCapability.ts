import {
  createConversationCapabilityContext,
  type ConversationCapabilityContextV1
} from "../../services/conversations/conversationCapability.js";
import type { ParsedIncomingMessage } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";

export function conversationCapabilityForIncoming(
  incoming: ParsedIncomingMessage,
  agentId: string,
  isAdmin: boolean,
  configEpoch: number
): Readonly<ConversationCapabilityContextV1> | undefined {
  try {
    return createConversationCapabilityContext({
      agentId: agentId.trim(),
      accountId: incoming.transport === "web"
        ? "web-admin"
        : incoming.accountId?.trim() || "primary",
      conversationId: conversationRecordId(incoming),
      transport: incoming.transport === "web" ? "web" : "onebot",
      scope: incoming.scope,
      userId: incoming.userId,
      isAdmin,
      ...(incoming.messageId === undefined ? {} : { messageId: incoming.messageId }),
      configEpoch
    });
  } catch {
    return undefined;
  }
}
