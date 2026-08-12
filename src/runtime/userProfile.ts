import { senderDisplayName } from "../../services/conversations/senderName.js";
import {
  readUserProfileForUser,
  recordMemoryOperation
} from "../../services/memory/public.js";
import { replaceUserProfileFromTool } from "../../services/memory/application/userProfileTool.js";
import {
  ADD_USER_PROFILE_TOOL_NAME,
  isAddUserProfileStableErrorCode,
  type AddUserProfileToolPort
} from "../../services/tools/public.js";
import type { ParsedIncomingMessage } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { SunaRuntime } from "../runtime.js";

type RuntimeUserProfileHost = Pick<SunaRuntime, "config">;

export class RuntimeUserProfile {
  constructor(private readonly host: RuntimeUserProfileHost) {}

  toolPort(incoming: ParsedIncomingMessage, sourceDecisionKey?: string): AddUserProfileToolPort {
    let decision: "pending" | "record" | "skip" | undefined;
    const conversationId = conversationRecordId(incoming);
    const userId = String(incoming.userId);
    const userName = senderDisplayName(incoming.sender) || userId;
    return {
      decisionRequired: true,
      decisionResolved: () => decision === "record" || decision === "skip",
      execute: async (input, signal) => {
        if (decision !== undefined) {
          return {
            ok: false,
            code: "ADD_USER_PROFILE_DECISION_DUPLICATE",
            error: "User-profile decision was already completed for this turn."
          };
        }
        decision = "pending";
        try {
          if (signal?.aborted) throw signal.reason ?? new Error("add_user_profile aborted");
          if (input.action === "skip") {
            recordMemoryOperation(this.host.config, {
              source: "user_profile",
              operation: "tool_decision",
              actor: "model_tool",
              outcome: "unchanged",
              conversationId,
              conversationScope: incoming.scope,
              changedCount: 0,
              reasonCode: "model_skipped"
            });
            decision = "skip";
            return { ok: true, action: "skip", message: "本轮无需更新用户画像。" };
          }
          if (!input.profile || !input.addressNames) {
            decision = undefined;
            return {
              ok: false,
              code: "ADD_USER_PROFILE_INVALID",
              error: "A complete profile and addressNames are required."
            };
          }
          const before = await readUserProfileForUser(this.host.config, userId);
          const result = await replaceUserProfileFromTool(this.host.config, {
            userId,
            userName,
            profile: input.profile,
            addressNames: input.addressNames,
            sourceDecisionKey
          });
          recordMemoryOperation(this.host.config, {
            source: "user_profile",
            operation: "tool_decision",
            actor: "model_tool",
            outcome: result.deduplicated ? "unchanged" : "recorded",
            conversationId,
            conversationScope: incoming.scope,
            recordIds: [result.entry.id],
            beforeCount: result.beforeCount,
            afterCount: result.afterCount,
            changedCount: result.deduplicated || (
              before?.text === result.entry.text
              && JSON.stringify(before.addressNames ?? []) === JSON.stringify(result.entry.addressNames ?? [])
            ) ? 0 : 1,
            reasonCode: result.deduplicated ? "model_recorded_deduplicated" : "model_recorded"
          });
          decision = "record";
          return {
            ok: true,
            action: "record",
            userId,
            profileId: result.entry.id,
            addressNameCount: result.entry.addressNames?.length ?? 0,
            deduplicated: result.deduplicated,
            message: "用户画像已更新。"
          };
        } catch (error) {
          decision = undefined;
          recordMemoryOperation(this.host.config, {
            source: "user_profile",
            operation: "tool_decision",
            actor: "model_tool",
            outcome: "failed",
            conversationId,
            conversationScope: incoming.scope,
            changedCount: 0,
            reasonCode: userProfileErrorCode(error)
          });
          throw error;
        }
      }
    };
  }

  recordToolDecision(incoming: ParsedIncomingMessage, toolNames: readonly string[]) {
    const invoked = toolNames.includes(ADD_USER_PROFILE_TOOL_NAME);
    recordMemoryOperation(this.host.config, {
      source: "user_profile",
      operation: "tool_decision",
      actor: "model_tool",
      outcome: invoked ? "rejected" : "failed",
      conversationId: conversationRecordId(incoming),
      conversationScope: incoming.scope,
      changedCount: 0,
      reasonCode: invoked ? "decision_unresolved" : "decision_missing"
    });
  }
}

function userProfileErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "").trim();
    if (isAddUserProfileStableErrorCode(code)) return code;
  }
  return "add_user_profile_failed";
}
