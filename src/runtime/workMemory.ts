import { appendWorkingMemoryDocumentItem, recordMemoryOperation } from "../../services/memory/public.js";
import { ADD_WORKMEMORY_TOOL_NAME, type AddWorkMemoryToolPort } from "../../services/tools/public.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { SunaRuntime } from "../runtime.js";

type RuntimeWorkingMemoryHost = Pick<SunaRuntime, "config" | "conversationRecords">;

export class RuntimeWorkingMemory {
  constructor(private readonly host: RuntimeWorkingMemoryHost) {}

  toolPort(incoming: ParsedIncomingMessage): AddWorkMemoryToolPort {
    const conversationId = conversationRecordId(incoming);
    const source = conversationSource(
      incoming,
      this.host.conversationRecords.get(conversationId),
      conversationId
    );
    return {
      execute: async (input, signal) => {
        try {
          if (signal?.aborted) throw signal.reason ?? new Error("add_workmemory aborted");
          const result = await appendWorkingMemoryDocumentItem(this.host.config, input.content, source);
          return {
            ok: true,
            id: result.item.id,
            recordedAt: result.item.recordedAt,
            timeZone: result.item.timeZone,
            conversationId: result.item.conversationId,
            conversationScope: result.item.conversationScope,
            revision: result.revision,
            message: "工作记忆已记录。"
          };
        } catch (error) {
          recordMemoryOperation(this.host.config, {
            source: "working",
            operation: "append",
            actor: "model_tool",
            outcome: "failed",
            conversationId: source.conversationId,
            conversationScope: source.scope,
            reasonCode: workingMemoryErrorCode(error)
          });
          throw error;
        }
      }
    };
  }

  recordToolDecision(incoming: ParsedIncomingMessage, toolNames: readonly string[]) {
    const conversationId = conversationRecordId(incoming);
    const invoked = toolNames.includes(ADD_WORKMEMORY_TOOL_NAME);
    recordMemoryOperation(this.host.config, {
      source: "working",
      operation: "tool_decision",
      actor: "model_tool",
      outcome: invoked ? "recorded" : "unchanged",
      conversationId,
      conversationScope: incoming.scope,
      changedCount: invoked ? 1 : 0,
      reasonCode: invoked ? "model_invoked" : "model_not_invoked"
    });
  }
}

function workingMemoryErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "").trim();
    if (code) return code;
  }
  return "add_workmemory_failed";
}

function conversationSource(
  incoming: ParsedIncomingMessage,
  record: ConversationRecord | undefined,
  conversationId: string
) {
  return {
    conversationId,
    scope: incoming.scope,
    title: record?.title ?? ""
  };
}
