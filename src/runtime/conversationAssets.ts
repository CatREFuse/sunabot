import { createHash } from "node:crypto";
import path from "node:path";
import type {
  OutboundConversationAssetRootIdentity,
  PrepareOutboundConversationAssetInput
} from "../../services/delivery/public.js";
import {
  captureOutboundConversationAssetRootIdentity,
  normalizeOutboundConversationAssetError,
  OutboundConversationAssetDelivery,
  OutboundConversationAssetSourceError
} from "../../services/delivery/public.js";
import {
  resolveAgentWorkbench,
  resolveAgentWorkbenchFile
} from "../../services/agents/public.js";
import {
  conversationAssetEnvelope,
  decodeConversationAsset,
  decodeIncomingReply,
  decodeToolCompletion,
  type ConversationAssetOutboxPayload,
  type ConversationAssetTargetV1,
  type QueuedConversationAssetRootIdentityV1
} from "../../packages/contracts/session/runtimeMessages.js";
import type {
  MessagingPort,
  PreparedOutboundConversationAssetV1
} from "../../packages/contracts/messaging/messages.js";
import {
  outboundAssetBubble,
  sendOutboundBubble
} from "../../packages/contracts/messaging/messages.js";
import { archiveConversationImage } from "../../services/media/conversationImageArchive.js";
import { resolveWorkbenchImageReferenceAddress } from "../../services/media/workbenchImageReference.js";
import {
  OutboxDisconnectedError,
  type OutboxDeliveryContext
} from "../../services/sessions/sessionCoordinator.js";
import {
  replayUnknownOutboxDedupeKey,
  type OutboxRecord
} from "../../services/sessions/sessionStore.js";
import { resolveProjectPath } from "../config.js";
import { appendRequestLogStrict } from "../../adapters/observability/requestLog.js";
import type { ParsedIncomingMessage } from "../types.js";
import type { ConversationAssetDeliveryDraft, ReplyDelivery } from "./runtimeContracts.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import { isRuntimeIncomingMessage, saveConversationRecordsStrict } from "./infrastructure.js";

import type { SunaRuntime } from "../runtime.js";

const MAX_CONVERSATION_ASSET_REPLAY_DEPTH = 8;

export interface QueueConversationAssetOptions {
  incoming: ParsedIncomingMessage;
  gateway: MessagingPort;
  input: PrepareOutboundConversationAssetInput;
  callId: string;
  logRunId: string;
  isCurrent?: () => boolean;
  delivery: ReplyDelivery;
  toolName?: "send_file" | "send_voice_message";
}

export class RuntimeConversationAssets {
  constructor(private readonly host: SunaRuntime) {}

  providerOptions(
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    logRunId: string,
    isCurrent: (() => boolean) | undefined,
    delivery: ReplyDelivery | undefined
  ) {
    if (incoming.transport === "web") return undefined;
    if (!this.host.isReplySenderAllowed(incoming.userId)) return undefined;
    if (!gateway.sendConversationAsset || !delivery?.emitOutbox) return undefined;
    return {
      enabled: true,
      send: (
        input: PrepareOutboundConversationAssetInput,
        context: { callId: string; toolName: "send_file" }
      ) => this.queue({ incoming, gateway, input, callId: context.callId, logRunId, isCurrent, delivery, toolName: context.toolName })
    };
  }

  async queue(options: QueueConversationAssetOptions) {
    const toolName = options.toolName ?? "send_file";
    const voice = toolName === "send_voice_message";
    if (options.incoming.transport === "web") {
      throw conversationAssetContractError();
    }
    if (
      (voice && options.input.kind !== "voice")
      || (!voice && options.input.kind !== "auto" && options.input.kind !== "file" && options.input.kind !== "image")
    ) {
      throw new Error("Conversation asset tool and kind do not match.");
    }
    if (!options.gateway.sendConversationAsset || !options.delivery.emitOutbox) {
      throw new Error("当前消息传输不支持可靠文件发送。");
    }
    if (options.isCurrent && !options.isCurrent()) {
      throw new Error("当前会话回复已关闭，文件未排队。");
    }

    const expectedAgentId = this.host.config.persona.defaultAgentId.trim();
    if (!expectedAgentId || (options.incoming.agentId && options.incoming.agentId !== expectedAgentId)) {
      throw conversationAssetContractError();
    }
    const target = conversationAssetTarget(options.incoming, expectedAgentId);
    const incomingFingerprint = conversationAssetIncomingFingerprint(options.incoming, target);
    const { relativePath, prepared, rootIdentity } = await this.prepare(
      options.input,
      undefined,
      undefined,
      conversationAssetWorkbench(options.incoming, this.host.isAdminUser(options.incoming.userId))
    );
    if (options.isCurrent && !options.isCurrent()) {
      throw new Error("当前会话回复已关闭，文件未排队。");
    }
    if (!prepared.sha256) throw new Error("Outbound conversation asset digest is missing.");

    const conversationId = target.conversationId;
    const deliveryPartition = target.accountId;
    const assetPayload: ConversationAssetOutboxPayload = {
      type: "conversation_asset",
      target,
      incomingFingerprint,
      toolName,
      asset: {
        path: relativePath,
        kind: prepared.kind,
        name: prepared.name,
        byteLength: prepared.byteLength,
        sha256: prepared.sha256,
        rootIdentity: serializeRootIdentity(rootIdentity)
      },
      logRunId: options.logRunId,
      replyGate: this.host.replyGates.capture(target.scope, conversationId)
    };
    const dedupeKey = conversationAssetIdempotencyKey(assetPayload);
    const payload = conversationAssetEnvelope(assetPayload, {
      conversationId,
      correlationId: options.logRunId,
      idempotencyKey: dedupeKey
    });
    const draft: ConversationAssetDeliveryDraft = {
      kind: "onebot.conversation_asset",
      deliveryPartition,
      dedupeKey,
      dedupeFingerprint: conversationAssetDraftFingerprint(payload.payload),
      payload
    };
    await options.delivery.emitOutbox(draft);
    return {
      ok: true,
      queued: true,
      kind: prepared.kind,
      name: prepared.name,
      byteLength: prepared.byteLength
    };
  }

  async resolveImageReferences(
    incoming: ParsedIncomingMessage,
    paths: readonly string[],
    isCurrent: () => boolean = () => true
  ) {
    const backend = conversationAssetWorkbench(incoming, this.host.isAdminUser(incoming.userId));
    const agentWorkspace = resolveProjectPath(this.host.config.persona.agentWorkspace);
    if (!agentWorkspace) throw new Error("当前 Agent 工作区未配置。");
    const urls: string[] = [];
    for (const imagePath of [...new Set(paths.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, 4)) {
      if (!isCurrent()) throw new Error("当前会话回复已关闭，参考图未读取。");
      const address = await resolveWorkbenchImageReferenceAddress(agentWorkspace, backend, imagePath);
      const { prepared } = await this.prepare(
        { path: address.path, kind: "image" },
        undefined,
        undefined,
        address.backend,
        address.exactBackend
      );
      if (!isCurrent()) throw new Error("当前会话回复已关闭，参考图未读取。");
      urls.push(await archiveConversationImage(this.host.config.persona.defaultAgentId, prepared));
    }
    return urls;
  }

  async deliver(outbox: OutboxRecord, delivery: OutboxDeliveryContext | AbortSignal) {
    if (!isOutboxDeliveryContext(delivery)) throw conversationAssetContractError();
    const context = delivery;
    const signal = context.signal;
    if (signal.aborted) throw signal.reason ?? new Error("Outbox delivery aborted.");

    const payload = decodeConversationAsset(outbox.payload);
    if ((payload.toolName === "send_voice_message") !== (payload.asset.kind === "voice")) throw conversationAssetContractError();
    const authoritativeIncoming = this.assertOutboxProvenance(outbox, payload);
    if (!isRuntimeIncomingMessage(authoritativeIncoming)) {
      throw new Error(`Outbox 消息格式无效：${outbox.id}`);
    }
    if (context.phase !== "settle" && !this.host.isReplySenderAllowed(authoritativeIncoming.userId)) {
      return { delivered: false, skipped: "sender_not_allowed" };
    }
    const conversationId = payload.target.conversationId;
    if (
      context.phase !== "settle" &&
      !this.host.isReplyTaskCurrent(authoritativeIncoming, payload.replyGate, signal)
    ) {
      return { delivered: false, skipped: "reply_gate_closed" };
    }

    let remoteReceipt = context.remoteReceipt;
    if (context.phase === "send") {
      const gateway = this.host.activeGateway;
      if (!gateway || !isOutboxAccountConnected(gateway, payload.target.accountId)) {
        throw new OutboxDisconnectedError("OneBot is not connected.");
      }
      if (!gateway.sendConversationAsset) {
        throw new Error("当前消息适配器不支持文件发送。");
      }
      const { prepared } = await this.prepare({
        path: payload.asset.path,
        kind: payload.asset.kind,
        name: payload.asset.name
      }, {
        byteLength: payload.asset.byteLength,
        sha256: payload.asset.sha256
      }, payload.asset.rootIdentity, conversationAssetWorkbench(
        authoritativeIncoming,
        this.host.isAdminUser(authoritativeIncoming.userId)
      ));
      const conversationImageUrl = prepared.kind === "image"
        ? await archiveConversationImage(payload.target.agentId, prepared)
        : undefined;
      const sendAsset = async () => {
        const receipt = await sendOutboundBubble(
          gateway,
          outboundAssetBubble(assetTarget(payload, prepared))
        );
        return conversationImageUrl ? { ...receipt, conversationImageUrl } : receipt;
      };
      remoteReceipt = await context.sendRemote(sendAsset);
    }

    const logRequest = {
      scope: payload.target.scope,
      accountId: payload.target.accountId,
      userId: payload.target.userId,
      groupId: payload.target.groupId ?? undefined,
      kind: payload.asset.kind,
      name: payload.asset.name,
      byteLength: payload.asset.byteLength,
      sha256: payload.asset.sha256
    };
    const logMetadata = {
      conversationId,
      incomingMessageId: payload.target.messageId == null
        ? undefined
        : String(payload.target.messageId),
      runId: payload.logRunId,
      stage: "reply"
    };
    if (payload.asset.kind === "image") {
      await context.settleStep("conversation_projection", async (idempotencyKey) => {
        const receipt = context.remoteReceipt ?? remoteReceipt;
        const imageUrl = conversationImageReceiptUrl(receipt, payload.target.agentId, payload.asset.sha256) ??
          await this.archiveQueuedImage(payload, authoritativeIncoming);
        const messageId = messagingReceiptMessageId(context.remoteReceipt ?? remoteReceipt) ?? idempotencyKey;
        this.host.recordAssistantMessage(
          authoritativeIncoming,
          "[图片]",
          [imageUrl],
          payload.logRunId,
          undefined,
          { toolNames: [payload.toolName] },
          { persist: false, messageId }
        );
        saveConversationRecordsStrict(
          [...this.host.conversationRecords.values()],
          idempotencyKey,
          this.host.config,
          this.host.protectedConversationIds()
        );
      });
    }
    await context.settleStep("request_log", (idempotencyKey) => appendRequestLogStrict({
      category: "runtime.action",
      action: "reply.asset.sent",
      request: logRequest,
      response: { status: "sent" },
      metadata: logMetadata
    }, idempotencyKey));
    return {
      delivered: true,
      remoteReceipt: context.remoteReceipt ?? remoteReceipt
    };
  }

  private async archiveQueuedImage(
    payload: ConversationAssetOutboxPayload,
    incoming: ParsedIncomingMessage
  ) {
    const { prepared } = await this.prepare({
      path: payload.asset.path,
      kind: payload.asset.kind,
      name: payload.asset.name
    }, {
      byteLength: payload.asset.byteLength,
      sha256: payload.asset.sha256
    }, payload.asset.rootIdentity, conversationAssetWorkbench(
      incoming,
      this.host.isAdminUser(incoming.userId)
    ));
    return archiveConversationImage(payload.target.agentId, prepared);
  }

  private async prepare(
    input: PrepareOutboundConversationAssetInput,
    expected?: { byteLength: number; sha256: string },
    expectedRootIdentity?: QueuedConversationAssetRootIdentityV1,
    preferredWorkbench: "native" | "docker" = "native",
    exactWorkbench = false
  ) {
    try {
      const agentWorkspace = resolveProjectPath(this.host.config.persona.agentWorkspace);
      if (!agentWorkspace) throw new Error("当前 Agent 工作区未配置。");
      const candidates: readonly ("native" | "docker")[] = expectedRootIdentity
        ? ([preferredWorkbench, preferredWorkbench === "native" ? "docker" : "native"] as const)
        : exactWorkbench
          ? ([preferredWorkbench] as const)
          : preferredWorkbench === "native"
            ? (["native", "docker"] as const)
            : (["docker"] as const);
      for (const backend of candidates) {
        try {
          const workbenchRoot = await resolveAgentWorkbench(agentWorkspace, backend);
          const rootIdentity = captureOutboundConversationAssetRootIdentity(workbenchRoot);
          if (expectedRootIdentity && !sameQueuedRootIdentity(expectedRootIdentity, rootIdentity)) {
            continue;
          }
          const resolvedFile = await resolveAgentWorkbenchFile(agentWorkspace, input.path, backend);
          const relativePath = safeQueuedConversationAssetPath(rootIdentity.canonicalPath, resolvedFile);
          const delivery = new OutboundConversationAssetDelivery({
            rootDir: workbenchRoot,
            rootIdentity
          });
          const prepared = await delivery.prepare(input, expected);
          return { relativePath, prepared, rootIdentity };
        } catch (error) {
          const normalized = normalizeOutboundConversationAssetError(error);
          const mayTryDocker = !expectedRootIdentity
            && !exactWorkbench
            && preferredWorkbench === "native"
            && backend === "native"
            && normalized instanceof OutboundConversationAssetSourceError
            && normalized.code === "SEND_FILE_SOURCE_MISSING";
          if (mayTryDocker) continue;
          throw normalized;
        }
      }
      throw new OutboundConversationAssetSourceError(
        "SEND_FILE_ROOT_CHANGED",
        "The Agent workbench root changed after the file was queued."
      );
    } catch (error) {
      throw normalizeOutboundConversationAssetError(error);
    }
  }

  private assertOutboxProvenance(outbox: OutboxRecord, payload: ConversationAssetOutboxPayload) {
    const canonical = this.host.sessionStore.getOutbox(outbox.id);
    if (
      !canonical ||
      canonical.sessionId !== outbox.sessionId ||
      canonical.originTurnId !== outbox.originTurnId ||
      canonical.kind !== outbox.kind ||
      canonical.dedupeKey !== outbox.dedupeKey ||
      canonical.deliveryPartition !== outbox.deliveryPartition ||
      JSON.stringify(canonical.payload) !== JSON.stringify(outbox.payload)
    ) {
      throw conversationAssetContractError();
    }

    const lineageOutbox = this.conversationAssetLineageOutbox(canonical);
    const turn = this.host.sessionStore.getTurn(lineageOutbox.originTurnId);
    const event = turn ? this.host.sessionStore.getEvent(turn.eventId) : undefined;
    if (
      !turn ||
      !event ||
      turn.sessionId !== lineageOutbox.sessionId ||
      event.sessionId !== lineageOutbox.sessionId
    ) {
      throw conversationAssetContractError();
    }
    const authoritativeIncoming = event.kind === "incoming_reply"
      ? decodeIncomingReply(event.payload).incoming
      : event.kind === "tool_completion"
        ? decodeToolCompletion(event.payload).originalRequest.incoming
        : undefined;
    if (!authoritativeIncoming) throw conversationAssetContractError();

    const expectedAgentId = this.host.config.persona.defaultAgentId.trim();
    if (!expectedAgentId) throw conversationAssetContractError();
    const expectedTarget = conversationAssetTarget(authoritativeIncoming, expectedAgentId);
    const expectedIncomingFingerprint = conversationAssetIncomingFingerprint(
      authoritativeIncoming,
      expectedTarget
    );
    const envelope = outbox.payload as Record<string, unknown>;
    const idempotencyKey = typeof envelope.idempotencyKey === "string" ? envelope.idempotencyKey : "";
    const expectedFingerprint = conversationAssetDraftFingerprint(payload);
    const expectedOutboxPrefix = `turn-outbox:${event.id}:`;
    const expectedOutboxSuffix = `:${expectedFingerprint}`;
    const outboxOrdinal = lineageOutbox.dedupeKey?.startsWith(expectedOutboxPrefix) &&
      lineageOutbox.dedupeKey.endsWith(expectedOutboxSuffix)
      ? lineageOutbox.dedupeKey.slice(expectedOutboxPrefix.length, -expectedOutboxSuffix.length)
      : "";
    if (
      lineageOutbox.kind !== "onebot.conversation_asset" ||
      !sameConversationAssetTarget(payload.target, expectedTarget) ||
      payload.incomingFingerprint !== expectedIncomingFingerprint ||
      lineageOutbox.deliveryPartition !== expectedTarget.accountId ||
      lineageOutbox.sessionId !== expectedTarget.conversationId ||
      envelope.conversationId !== expectedTarget.conversationId ||
      envelope.correlationId !== payload.logRunId ||
      idempotencyKey !== conversationAssetIdempotencyKey(payload) ||
      !/^[1-9]\d*$/.test(outboxOrdinal)
    ) {
      throw conversationAssetContractError();
    }
    return authoritativeIncoming;
  }

  private conversationAssetLineageOutbox(canonical: OutboxRecord) {
    const visited = new Set<string>();
    let current = canonical;
    for (let depth = 0; depth <= MAX_CONVERSATION_ASSET_REPLAY_DEPTH; depth += 1) {
      if (visited.has(current.id)) throw conversationAssetContractError();
      visited.add(current.id);

      const replay = parseReplayDedupeKey(current.dedupeKey);
      if (!replay) {
        if (!current.dedupeKey?.startsWith("turn-outbox:")) {
          throw conversationAssetContractError();
        }
        return current;
      }
      if (depth === MAX_CONVERSATION_ASSET_REPLAY_DEPTH) {
        throw conversationAssetContractError();
      }

      const previous = this.host.sessionStore.getOutbox(replay.originalId);
      if (
        !previous ||
        visited.has(previous.id) ||
        previous.status !== "delivery_unknown" ||
        previous.uncertainSettleStep ||
        current.dedupeKey !== replayUnknownOutboxDedupeKey(previous) ||
        current.sessionId !== previous.sessionId ||
        current.originTurnId !== previous.originTurnId ||
        current.kind !== previous.kind ||
        current.deliveryPartition !== previous.deliveryPartition ||
        JSON.stringify(current.payload) !== JSON.stringify(previous.payload)
      ) {
        throw conversationAssetContractError();
      }
      current = previous;
    }
    throw conversationAssetContractError();
  }
}

function messagingReceiptMessageId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
}

function conversationImageReceiptUrl(value: unknown, agentId: string, sha256: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const imageUrl = (value as { conversationImageUrl?: unknown }).conversationImageUrl;
  if (typeof imageUrl !== "string") return undefined;
  const prefix = `/generated-images/conversation-assets/agents/${encodeURIComponent(agentId)}/`;
  if (!imageUrl.startsWith(prefix)) return undefined;
  const fileName = imageUrl.slice(prefix.length);
  return fileName.startsWith(`${sha256}.`) && /^[a-f0-9]{64}\.[a-z0-9]+$/i.test(fileName)
    ? imageUrl
    : undefined;
}

function conversationAssetWorkbench(
  incoming: ParsedIncomingMessage,
  isAdmin: boolean
): "native" | "docker" {
  return isAdmin && incoming.scope === "private" && incoming.groupId === undefined
    ? "native"
    : "docker";
}

function conversationAssetContractError() {
  return Object.assign(new Error("conversation_asset outbox provenance is invalid."), {
    code: "contract_field_invalid"
  });
}

function parseReplayDedupeKey(value: string | undefined) {
  if (!value?.startsWith("outbox-replay:")) return undefined;
  const separator = value.lastIndexOf(":");
  const originalId = value.slice("outbox-replay:".length, separator);
  const fingerprint = value.slice(separator + 1);
  if (!originalId || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw conversationAssetContractError();
  }
  return { originalId, fingerprint };
}

function conversationAssetTarget(
  incoming: ParsedIncomingMessage,
  agentId: string
): ConversationAssetTargetV1 {
  if (incoming.transport === "web") throw conversationAssetContractError();
  const accountId = incoming.accountId?.trim() || "primary";
  const groupId = incoming.groupId ?? null;
  const messageId = incoming.messageId ?? null;
  const selfId = incoming.selfId ?? null;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(accountId) ||
    !agentId ||
    incoming.userId <= 0 ||
    !Number.isSafeInteger(incoming.userId) ||
    (incoming.scope === "private" && groupId !== null) ||
    (incoming.scope !== "private" && groupId === null)
  ) {
    throw conversationAssetContractError();
  }
  const canonicalIncoming = {
    ...incoming,
    agentId,
    accountId
  };
  return {
    transport: "onebot",
    agentId,
    accountId,
    scope: incoming.scope,
    userId: incoming.userId,
    groupId,
    messageId,
    selfId,
    conversationId: conversationRecordId(canonicalIncoming)
  };
}

function conversationAssetIncomingFingerprint(
  incoming: ParsedIncomingMessage,
  target: ConversationAssetTargetV1
) {
  return hashCanonical({
    schemaVersion: 1,
    type: "conversation_asset_origin",
    transport: "onebot",
    target,
    messageId: incoming.messageId ?? null,
    selfId: incoming.selfId ?? null,
    time: incoming.time
  });
}

function conversationAssetDraftFingerprint(payload: ConversationAssetOutboxPayload) {
  return hashCanonical({
    schemaVersion: 2,
    type: payload.type,
    target: payload.target,
    incomingFingerprint: payload.incomingFingerprint,
    toolName: payload.toolName,
    asset: payload.asset
  });
}

function conversationAssetIdempotencyKey(payload: ConversationAssetOutboxPayload) {
  return `conversation-asset:${hashCanonical({
    schemaVersion: 2,
    payload
  })}`;
}

function serializeRootIdentity(
  identity: OutboundConversationAssetRootIdentity
): QueuedConversationAssetRootIdentityV1 {
  return {
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
    ctimeNs: identity.ctimeNs.toString(10)
  };
}

function sameQueuedRootIdentity(
  expected: QueuedConversationAssetRootIdentityV1,
  actual: OutboundConversationAssetRootIdentity
) {
  return expected.dev === actual.dev.toString(10) &&
    expected.ino === actual.ino.toString(10) &&
    expected.ctimeNs === actual.ctimeNs.toString(10);
}

function sameConversationAssetTarget(
  left: ConversationAssetTargetV1,
  right: ConversationAssetTargetV1
) {
  return left.agentId === right.agentId &&
    left.transport === right.transport &&
    left.accountId === right.accountId &&
    left.scope === right.scope &&
    left.userId === right.userId &&
    left.groupId === right.groupId &&
    left.messageId === right.messageId &&
    left.selfId === right.selfId &&
    left.conversationId === right.conversationId;
}

function hashCanonical(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().flatMap((key) => {
    const item = record[key];
    return item === undefined ? [] : [`${JSON.stringify(key)}:${stableJson(item)}`];
  }).join(",")}}`;
}

function safeQueuedConversationAssetPath(rootDir: string, resolvedFile: string) {
  const relativePath = path.relative(rootDir, resolvedFile);
  const normalized = relativePath.split(path.sep).join("/");
  if (
    !normalized ||
    normalized.length > 1_024 ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_UNSAFE",
      "The requested workbench path changed before it could be queued."
    );
  }
  return normalized;
}

function assetTarget(
  payload: ConversationAssetOutboxPayload,
  prepared: PreparedOutboundConversationAssetV1
) {
  return {
    accountId: payload.target.accountId,
    scope: payload.target.scope,
    userId: payload.target.userId,
    ...(payload.target.groupId == null ? {} : { groupId: payload.target.groupId }),
    asset: prepared
  };
}

function isOutboxDeliveryContext(value: OutboxDeliveryContext | AbortSignal): value is OutboxDeliveryContext {
  return typeof (value as OutboxDeliveryContext).sendRemote === "function";
}

function isOutboxAccountConnected(gateway: MessagingPort, accountId?: string) {
  const status = gateway.getStatus();
  if (!status.connected) return false;
  if (!accountId || !status.accounts) return true;
  return status.accounts.some((account) => account.accountId === accountId);
}
