import { createHash } from "node:crypto";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import {
  SYSTEM_CONFIG_TOOL_NAME,
  type SystemConfigMutationDescriptor,
  type SystemConfigTurn
} from "../../services/tools/systemConfigTool.js";
import type { SunaRuntime } from "../runtime.js";
import type {
  AssistantMessageOrigin,
  ImageResult,
  ParsedIncomingMessage
} from "../types.js";
import type {
  ReplyDelivery,
  ReplyDeliveryDraft,
  SystemConfigHeldConfirmationHandle
} from "./runtimeContracts.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";

interface SystemConfigReplyBinding {
  agentId: string;
  conversationId: string;
  administratorUserId: number;
}

interface SystemConfigFinalReplyInput {
  lifecycle?: SystemConfigReplyLifecycle;
  channelKey: string;
  incoming: ParsedIncomingMessage;
  gateway: MessagingPort;
  text: string;
  isAdmin: boolean;
  generatedImages: ImageResult[];
  logRunId: string;
  isCurrent?: () => boolean;
  delivery?: ReplyDelivery;
  messageOrigin: AssistantMessageOrigin;
  toolNames: readonly string[];
}

export class SystemConfigReplyLifecycle {
  readonly toolPort: SystemConfigTurn;
  private appendStarted = false;
  private heldHandle: SystemConfigHeldConfirmationHandle | undefined;
  private mutationPrepared = false;
  private discarded = false;

  constructor(
    turn: SystemConfigTurn,
    private readonly binding: SystemConfigReplyBinding
  ) {
    this.toolPort = turn;
  }

  prepareFinalDelivery(input: Pick<
    SystemConfigFinalReplyInput,
    "delivery" | "generatedImages" | "messageOrigin" | "toolNames"
  >) {
    if (this.toolPort.turnRejected()) {
      throw lifecycleError("system_config 与其他输出或工具混用，当前回合已拒绝。");
    }
    const descriptor = this.toolPort.stagedMutation();
    if (!descriptor) {
      if (this.toolPort.mutationStaged()) {
        throw lifecycleError("system_config 缺少已暂存修改的规范描述。");
      }
      return { delivery: input.delivery, timing: "buffered" as const };
    }
    if (!this.toolPort.mutationStaged()) {
      throw lifecycleError("system_config 修改状态不一致。");
    }
    if (
      input.messageOrigin !== "text" ||
      input.generatedImages.length > 0 ||
      input.toolNames.length !== 1 ||
      input.toolNames[0] !== SYSTEM_CONFIG_TOOL_NAME
    ) {
      throw lifecycleError("system_config 修改回合只能生成纯文本确认。");
    }
    const delivery = input.delivery;
    const heldPort = delivery?.systemConfigHeld;
    if (!heldPort) throw lifecycleError("配置修改缺少 held 持久化投递通道。");
    if (delivery.outbox.length > 0) {
      throw lifecycleError("system_config 修改前已产生其他外发内容。");
    }
    const mutationFingerprint = systemConfigMutationFingerprint(this.binding, descriptor);
    this.mutationPrepared = true;
    return {
      timing: "immediate" as const,
      delivery: {
        ...delivery,
        emitOutbox: async (draft: ReplyDelivery["outbox"][number]) => {
          if (this.appendStarted) throw lifecycleError("配置确认只能持久化一次。");
          this.appendStarted = true;
          if (draft.kind !== "onebot.reply") {
            throw lifecycleError("配置确认投递类型无效。");
          }
          if (marksPrivateGateClosingConfirmation(draft, descriptor, this.binding)) {
            draft.payload.payload.deliverySemantics = "system_config_confirmation";
          }
          this.heldHandle = await heldPort.appendHeld(draft, { mutationFingerprint });
        }
      }
    };
  }

  async commitAndRelease() {
    if (!this.mutationPrepared) return;
    const handle = this.heldHandle;
    if (!handle) {
      this.discard();
      throw lifecycleError("配置确认未进入 held 持久化队列。");
    }
    try {
      await this.toolPort.commit();
    } catch (commitError) {
      this.discard();
      try {
        await handle.neutralizeAndRelease();
      } catch (neutralizeError) {
        throw lifecycleError("配置提交失败，held 确认无法原子转为中性通知。", [
          commitError,
          neutralizeError
        ]);
      }
      throw lifecycleError("配置提交失败，已释放中性通知。", commitError);
    }
    try {
      await handle.release();
    } catch (releaseError) {
      throw lifecycleError("配置已提交，但 held 确认尚未释放。", releaseError);
    }
  }

  discard() {
    if (this.discarded) return;
    this.discarded = true;
    this.toolPort.discard();
  }

  suppressesOrdinaryFailureReply() {
    return this.mutationPrepared || this.appendStarted || this.toolPort.turnRejected();
  }
}

export function createSystemConfigReplyLifecycle(
  host: Pick<SunaRuntime, "config" | "systemConfig">,
  incoming: ParsedIncomingMessage,
  isAdmin: boolean,
  promptOverride: string | undefined,
  promptRequest: RenderedPromptRequest
) {
  const authorized = incoming.scope === "private" && isAdmin && promptOverride === undefined;
  if (!host.systemConfig || !authorized) return undefined;
  const binding = {
    agentId: host.config.persona.defaultAgentId,
    conversationId: conversationRecordId(incoming),
    administratorUserId: incoming.userId
  };
  const turn = host.systemConfig.createTurn({
    agentId: binding.agentId,
    conversationId: binding.conversationId,
    promptToolNames: (promptRequest.tools ?? []).map((tool) => tool.function.name)
  });
  return new SystemConfigReplyLifecycle(turn, binding);
}

export async function sendSystemConfigAwareFinalReply(
  host: SunaRuntime,
  input: SystemConfigFinalReplyInput
) {
  let prepared: ReturnType<SystemConfigReplyLifecycle["prepareFinalDelivery"]> | undefined;
  try {
    prepared = input.lifecycle?.prepareFinalDelivery(input);
    const record = await host.sendAssistantReply(
      input.channelKey,
      input.incoming,
      input.gateway,
      input.text,
      input.isAdmin,
      input.generatedImages,
      input.logRunId,
      input.isCurrent,
      prepared?.delivery ?? input.delivery,
      true,
      { messageOrigin: input.messageOrigin, toolNames: [...input.toolNames] },
      prepared?.timing ?? "buffered"
    );
    await input.lifecycle?.commitAndRelease();
    if (record) host.scheduleMemoryCompression(record);
    return Boolean(record);
  } catch (error) {
    const suppress = input.lifecycle?.suppressesOrdinaryFailureReply() === true;
    input.lifecycle?.discard();
    if (suppress && !(error instanceof SystemConfigReplyLifecycleError)) {
      throw lifecycleError("system_config 确认生命周期失败。", error);
    }
    throw error;
  }
}

export function shouldSuppressSystemConfigFailureReply(error: unknown) {
  return error instanceof SystemConfigReplyLifecycleError;
}

export function systemConfigMutationFingerprint(
  binding: SystemConfigReplyBinding,
  descriptor: SystemConfigMutationDescriptor
) {
  const canonical = JSON.stringify({
    agentId: binding.agentId,
    conversationId: binding.conversationId,
    administratorUserId: String(binding.administratorUserId),
    action: descriptor.action,
    parameters: {
      replyScope: descriptor.normalizedInput.replyScope,
      enabled: descriptor.normalizedInput.enabled,
      orchestratorEnabled: descriptor.normalizedInput.orchestratorEnabled,
      searchImplementation: descriptor.normalizedInput.searchImplementation,
      bashAdminBackend: descriptor.normalizedInput.bashAdminBackend,
      conversationId: descriptor.normalizedInput.conversationId
    },
    closesCurrentPrivateReplyGate: descriptor.closesCurrentPrivateReplyGate
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function marksPrivateGateClosingConfirmation(
  draft: ReplyDeliveryDraft,
  descriptor: SystemConfigMutationDescriptor,
  binding: SystemConfigReplyBinding
) {
  const payload = draft.payload.payload;
  return descriptor.closesCurrentPrivateReplyGate &&
    descriptor.action === "set_auto_reply" &&
    (descriptor.normalizedInput.replyScope === "private" || descriptor.normalizedInput.replyScope === "all") &&
    descriptor.normalizedInput.enabled === false &&
    payload.incoming.transport !== "web" &&
    payload.incoming.scope === "private" &&
    payload.incoming.groupId == null &&
    payload.incoming.userId === binding.administratorUserId &&
    payload.isAdmin === true &&
    payload.messageOrigin === "text" &&
    payload.generatedImages.length === 0 &&
    payload.text.trim().length > 0 &&
    payload.toolNames?.length === 1 &&
    payload.toolNames[0] === SYSTEM_CONFIG_TOOL_NAME;
}

class SystemConfigReplyLifecycleError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SystemConfigReplyLifecycleError";
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

function lifecycleError(message: string, cause?: unknown) {
  return new SystemConfigReplyLifecycleError(message, cause);
}
