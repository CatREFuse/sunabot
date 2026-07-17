import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../types.js";
import type { SunaRuntime } from "../runtime.js";
import { conversationReplyEnabled } from "./messagingAttachmentHelpers.js";

export async function handleInboundConversationGate(
  host: SunaRuntime,
  incoming: ParsedIncomingMessage,
  gateway: MessagingPort,
  activeDebounceConversation: ConversationRecord | undefined,
  durableMessageId: string
) {
  const record = host.ensureConversationRecord(incoming, incoming.time);
  if (await host.handlePersistedReplyDuplicate(incoming, gateway, record, durableMessageId)) {
    return true;
  }
  if (conversationReplyEnabled(record)) return false;

  const rollback = activeDebounceConversation
    ? conversationRecordSnapshot(activeDebounceConversation)
    : undefined;
  let persistedRecord: ConversationRecord;
  try {
    persistedRecord = host.recordIncomingMessage(incoming, {
      persist: !activeDebounceConversation
    });
    if (activeDebounceConversation) host.persistConversationRecordStrict(persistedRecord);
  } catch (error) {
    if (rollback && activeDebounceConversation) {
      restoreConversationRecord(activeDebounceConversation, rollback);
    }
    throw error;
  }
  host.markIncomingSeen(incoming);
  host.markConversationMessagesAsRecordedOnly(persistedRecord);
  return true;
}

export function conversationRecordSnapshot(record: ConversationRecord): ConversationRecord {
  return { ...record, messages: [...record.messages] };
}

export function restoreConversationRecord(record: ConversationRecord, snapshot: ConversationRecord) {
  const mutable = record as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(snapshot, key)) delete mutable[key];
  }
  Object.assign(record, snapshot);
}
