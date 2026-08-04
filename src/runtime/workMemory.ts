import { recordMemoryOperation } from "../../services/memory/public.js";
import { appendWorkingMemoryDocumentItem } from "../../services/memory/workingMemoryDocument.js";
import { ADD_WORKMEMORY_TOOL_NAME, type AddWorkMemoryToolPort } from "../../services/tools/public.js";
import { isAddWorkMemoryStableErrorCode } from "../../services/tools/addWorkMemoryTool.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { SunaRuntime } from "../runtime.js";

type RuntimeWorkingMemoryHost = Pick<SunaRuntime, "config" | "conversationRecords">;

export class RuntimeWorkingMemory {
  constructor(private readonly host: RuntimeWorkingMemoryHost) {}

  toolPort(incoming: ParsedIncomingMessage, sourceDecisionKey?: string): AddWorkMemoryToolPort {
    let decision: "pending" | "record" | "skip" | undefined;
    const conversationId = conversationRecordId(incoming);
    const source = conversationSource(
      incoming,
      this.host.conversationRecords.get(conversationId),
      conversationId,
      sourceDecisionKey
    );
    return {
      decisionRequired: true,
      decisionResolved: () => decision === "record" || decision === "skip",
      execute: async (input, signal) => {
        if (decision !== undefined) {
          return {
            ok: false,
            code: "ADD_WORKMEMORY_DECISION_DUPLICATE",
            error: "Working-memory decision was already completed for this turn."
          };
        }
        decision = "pending";
        try {
          if (signal?.aborted) throw signal.reason ?? new Error("add_workmemory aborted");
          if (input.action === "skip") {
            recordMemoryOperation(this.host.config, {
              source: "working",
              operation: "tool_decision",
              actor: "model_tool",
              outcome: "unchanged",
              conversationId: source.conversationId,
              conversationScope: source.scope,
              changedCount: 0,
              reasonCode: "model_skipped"
            });
            decision = "skip";
            return { ok: true, action: "skip", message: "本轮无需记录工作记忆。" };
          }
          if (!input.content) {
            decision = undefined;
            return {
              ok: false,
              code: "ADD_WORKMEMORY_INVALID",
              error: "Working-memory content is required."
            };
          }
          const result = await appendWorkingMemoryDocumentItem(this.host.config, input.content, source);
          recordMemoryOperation(this.host.config, {
            source: "working",
            operation: "tool_decision",
            actor: "model_tool",
            outcome: "recorded",
            conversationId: source.conversationId,
            conversationScope: source.scope,
            changedCount: 1,
            reasonCode: "model_recorded"
          });
          decision = "record";
          return {
            ok: true,
            action: "record",
            id: result.item.id,
            recordedAt: result.item.recordedAt,
            timeZone: result.item.timeZone,
            conversationId: result.item.conversationId,
            conversationScope: result.item.conversationScope,
            revision: result.revision,
            deduplicated: result.deduplicated,
            message: "工作记忆已记录。"
          };
        } catch (error) {
          decision = undefined;
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
      outcome: invoked ? "rejected" : "failed",
      conversationId,
      conversationScope: incoming.scope,
      changedCount: 0,
      reasonCode: invoked ? "decision_unresolved" : "decision_missing"
    });
  }
}

function workingMemoryErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "").trim();
    if (isAddWorkMemoryStableErrorCode(code)) return code;
  }
  return "add_workmemory_failed";
}

function conversationSource(
  incoming: ParsedIncomingMessage,
  record: ConversationRecord | undefined,
  conversationId: string,
  sourceDecisionKey?: string
) {
  return {
    conversationId,
    scope: incoming.scope,
    title: record?.title ?? "",
    ...(sourceDecisionKey ? { sourceDecisionKey } : {})
  };
}
