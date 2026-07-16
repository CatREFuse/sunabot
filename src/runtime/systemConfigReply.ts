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
import type { SessionTurnContext } from "../../services/sessions/sessionCoordinator.js";
import type { OutboxRecord } from "../../services/sessions/sessionStore.js";
import { readReplyGateSnapshot } from "../../services/orchestration/groupReplyPolicy.js";
import {
  SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT,
  type AssistantReplyOutboxPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import { conversationReplyEnabled } from "./messagingAttachmentHelpers.js";

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
  private protectCurrentReplyFromGateClosure = false;

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
            this.protectCurrentReplyFromGateClosure = true;
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

  protectsCurrentPrivateReplyFromGateClosure() {
    return this.protectCurrentReplyFromGateClosure;
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

export function createSystemConfigHeldConfirmationPort(
  host: Pick<SunaRuntime, "replyGates">,
  appendHeldOutbox: SessionTurnContext["appendHeldOutbox"] | undefined
): ReplyDelivery["systemConfigHeld"] {
  if (!appendHeldOutbox) return undefined;
  return {
    appendHeld: async (draft, options) => {
      const payload = decodeHeldConfirmationPayload(draft);
      const conversationId = conversationRecordId(payload.incoming);
      const originalReplyGate = readReplyGateSnapshot(
        payload.replyGate,
        payload.incoming.scope,
        conversationId
      );
      if (!originalReplyGate) {
        throw lifecycleError("配置确认缺少可信回复门禁快照。");
      }
      const releasePolicy = payload.deliverySemantics === "system_config_confirmation"
        ? "private_scope_plus_one" as const
        : "unchanged" as const;
      const handle = await appendHeldOutbox(draft, {
        mutationFingerprint: options.mutationFingerprint,
        semantics: "system_config_confirmation",
        originalReplyGate,
        releasePolicy
      });
      const currentGate = () => host.replyGates.capture(
        originalReplyGate.scope,
        originalReplyGate.conversationId
      );
      return {
        release: async () => { await handle.release(currentGate()); },
        neutralizeAndRelease: async () => { await handle.neutralizeAndRelease(currentGate()); }
      };
    }
  };
}

export function validateHeldSystemConfigConfirmation(
  host: SunaRuntime,
  outbox: OutboxRecord,
  payload: AssistantReplyOutboxPayload,
  checkCurrent: boolean,
  signal: AbortSignal
) {
  if (!outbox.holdState || outbox.holdState === "none") return undefined;
  if (outbox.holdState === "held") {
    throw new Error(`Held outbox ${outbox.id} cannot be delivered before release.`);
  }
  const hold = outbox.holdProvenance;
  const release = outbox.releaseProvenance;
  if (!hold || !release || !outbox.mutationFingerprint ||
    hold.semantics !== "system_config_confirmation" ||
    release.outcome !== outbox.holdState) {
    throw new Error(`Held outbox ${outbox.id} provenance is invalid.`);
  }
  validateHeldOutboxLineage(host, outbox);
  const conversationId = conversationRecordId(payload.incoming);
  if (
    payload.incoming.transport === "web" ||
    payload.incoming.scope !== "private" ||
    payload.incoming.groupId != null ||
    payload.isAdmin !== true ||
    !host.isAdminUser(payload.incoming.userId) ||
    payload.messageOrigin !== "text" ||
    payload.toolNames?.length !== 1 ||
    payload.toolNames[0] !== SYSTEM_CONFIG_TOOL_NAME ||
    hold.originalReplyGate.scope !== "private" ||
    hold.originalReplyGate.conversationId !== conversationId ||
    outbox.sessionId !== conversationId ||
    outbox.deliveryPartition !== (payload.incoming.accountId ?? "primary") ||
    !sameReplyGateSnapshot(payload.replyGate, hold.originalReplyGate)
  ) {
    throw new Error(`Held outbox ${outbox.id} confirmation shape is invalid.`);
  }
  const closingPrivateGate = hold.releasePolicy === "private_scope_plus_one";
  if (outbox.holdState === "released") {
    if (closingPrivateGate !== (payload.deliverySemantics === "system_config_confirmation") ||
      !validHeldReleaseTransition(hold.originalReplyGate, release.replyGate, closingPrivateGate, false)) {
      throw new Error(`Held outbox ${outbox.id} release provenance is invalid.`);
    }
  } else if (
    payload.deliverySemantics !== undefined ||
    payload.text !== SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT ||
    payload.generatedImages.length !== 0 ||
    !validHeldReleaseTransition(hold.originalReplyGate, release.replyGate, closingPrivateGate, true)
  ) {
    throw new Error(`Held outbox ${outbox.id} fallback provenance is invalid.`);
  }
  if (!checkCurrent) return { current: true };
  if (signal.aborted) return { current: false };
  const currentGate = host.replyGates.capture("private", conversationId);
  const gateCurrent = currentGate.generation === release.replyGate.generation
    ? sameReplyGateSnapshot(currentGate, release.replyGate)
    : currentGate.scopeEpoch === 0 && currentGate.conversationEpoch === 0;
  if (!gateCurrent) return { current: false };
  const record = host.conversationRecords.get(conversationId);
  if (!record || !conversationReplyEnabled(record)) return { current: false };
  if (closingPrivateGate) return { current: true };
  return { current: host.isReplyTaskCurrent(payload.incoming, release.replyGate, signal) };
}

export function sameCanonicalOutbox(canonical: OutboxRecord, claimed: OutboxRecord) {
  return canonical.id === claimed.id && canonical.sessionId === claimed.sessionId &&
    canonical.sequence === claimed.sequence && canonical.originTurnId === claimed.originTurnId &&
    canonical.kind === claimed.kind && canonical.dedupeKey === claimed.dedupeKey &&
    canonical.deliveryPartition === claimed.deliveryPartition &&
    canonical.partitionSequence === claimed.partitionSequence && canonical.status === claimed.status &&
    canonical.holdState === (claimed.holdState ?? "none") &&
    canonical.mutationFingerprint === claimed.mutationFingerprint &&
    JSON.stringify(canonical.payload) === JSON.stringify(claimed.payload) &&
    JSON.stringify(canonical.holdProvenance) === JSON.stringify(claimed.holdProvenance) &&
    JSON.stringify(canonical.releaseProvenance) === JSON.stringify(claimed.releaseProvenance);
}

function validHeldReleaseTransition(
  original: NonNullable<OutboxRecord["holdProvenance"]>["originalReplyGate"],
  release: NonNullable<OutboxRecord["releaseProvenance"]>["replyGate"],
  closingPrivateGate: boolean,
  fallback: boolean
) {
  if (original.scope !== release.scope || original.conversationId !== release.conversationId) return false;
  if (original.generation !== release.generation) {
    return fallback && release.scopeEpoch === 0 && release.conversationEpoch === 0;
  }
  if (original.conversationEpoch !== release.conversationEpoch) return false;
  if (!closingPrivateGate) return original.scopeEpoch === release.scopeEpoch;
  return release.scopeEpoch === original.scopeEpoch + 1 ||
    (fallback && release.scopeEpoch === original.scopeEpoch);
}

function validateHeldOutboxLineage(host: SunaRuntime, outbox: OutboxRecord) {
  const lineage = outbox.holdProvenance?.lineage ?? [];
  if (lineage.length === 0) {
    const turn = host.sessionStore.getTurn(outbox.originTurnId);
    if (!turn || !outbox.dedupeKey?.startsWith(`turn-outbox:${turn.eventId}:`)) {
      throw new Error(`Held outbox ${outbox.id} origin ordinal is invalid.`);
    }
  } else {
    const source = lineage.at(-1)!;
    if (outbox.dedupeKey !== `outbox-replay:${source.outboxId}:${source.mutationFingerprint}`) {
      throw new Error(`Held outbox ${outbox.id} replay dedupe key is invalid.`);
    }
  }
  for (const [index, entry] of lineage.entries()) {
    const source = host.sessionStore.getOutbox(entry.outboxId);
    if (!source || source.status !== "delivery_unknown" || source.uncertainSettleStep ||
      source.sessionId !== outbox.sessionId || source.originTurnId !== outbox.originTurnId ||
      source.kind !== outbox.kind || source.deliveryPartition !== outbox.deliveryPartition ||
      source.mutationFingerprint !== entry.mutationFingerprint ||
      source.holdState !== entry.holdState ||
      JSON.stringify(source.payload) !== JSON.stringify(outbox.payload) ||
      JSON.stringify(source.releaseProvenance) !== JSON.stringify(outbox.releaseProvenance) ||
      JSON.stringify(source.holdProvenance?.lineage) !== JSON.stringify(lineage.slice(0, index))) {
      throw new Error(`Held outbox ${outbox.id} replay lineage is invalid.`);
    }
  }
}

function sameReplyGateSnapshot(
  left: AssistantReplyOutboxPayload["replyGate"],
  right: NonNullable<AssistantReplyOutboxPayload["replyGate"]>
) {
  return left?.generation === right.generation && left.scope === right.scope &&
    left.conversationId === right.conversationId && left.scopeEpoch === right.scopeEpoch &&
    left.conversationEpoch === right.conversationEpoch;
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
    if (prepared?.timing === "immediate" && input.lifecycle?.protectsCurrentPrivateReplyFromGateClosure()) {
      host.activeDirectControllers.delete(input.channelKey);
    }
    await input.lifecycle?.commitAndRelease();
    if (prepared?.timing === "immediate" && input.delivery) {
      input.delivery.terminalStatus = "replied";
    }
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

function decodeHeldConfirmationPayload(draft: ReplyDeliveryDraft) {
  if (draft.kind !== "onebot.reply") {
    throw lifecycleError("配置确认投递类型无效。");
  }
  return draft.payload.payload;
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
