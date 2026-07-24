import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import type { CronToolInput } from "../../services/tools/cronTool.js";
import type { ParsedIncomingMessage } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";

export function resolveScheduledTaskCurrentTargets(
  input: CronToolInput,
  incoming: ParsedIncomingMessage
): CronToolInput {
  if (!input.targets?.some((target) => target.conversationId === "current")) return input;
  if (incoming.transport === "web") {
    throw new ServiceError(
      400,
      "SCHEDULED_TASK_TARGET_INVALID",
      "Web Chat 中不能使用 current，请选择一个已有 QQ 会话。"
    );
  }
  const current = conversationRecordId(incoming);
  return {
    ...input,
    targets: input.targets.map((target) => ({
      ...target,
      conversationId: target.conversationId === "current" ? current : target.conversationId
    }))
  };
}
