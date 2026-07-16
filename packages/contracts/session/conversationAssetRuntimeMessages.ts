import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OutboundConversationAssetKindV1 } from "../messaging/messages.js";
import type { ReplyGateSnapshotV1 } from "./runtimeMessages.js";

export interface ConversationAssetTargetV1 {
  transport: "onebot";
  agentId: string;
  accountId: string;
  scope: "private" | "user_group" | "bot_group";
  userId: number;
  groupId: number | null;
  messageId: number | null;
  selfId: number | null;
  conversationId: string;
}

export interface QueuedConversationAssetRootIdentityV1 {
  dev: string;
  ino: string;
  ctimeNs: string;
}

export interface QueuedConversationAssetV2 {
  path: string;
  kind: OutboundConversationAssetKindV1;
  name: string;
  byteLength: number;
  sha256: string;
  rootIdentity: QueuedConversationAssetRootIdentityV1;
}

export interface ConversationAssetOutboxPayload {
  type: "conversation_asset";
  target: ConversationAssetTargetV1;
  incomingFingerprint: string;
  toolName: "send_file" | "send_voice_message";
  asset: QueuedConversationAssetV2;
  logRunId: string;
  replyGate: ReplyGateSnapshotV1;
}

export interface ConversationAssetOutboxEnvelope {
  schemaVersion: 2;
  id: string;
  type: "runtime.conversation_asset";
  occurredAt: string;
  conversationId: string;
  correlationId: string;
  idempotencyKey: string;
  payload: ConversationAssetOutboxPayload;
}

interface ConversationAssetEnvelopeOptions {
  conversationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  occurredAt?: string;
  id?: string;
}

export function conversationAssetEnvelope(
  payload: ConversationAssetOutboxPayload,
  options: ConversationAssetEnvelopeOptions
): ConversationAssetOutboxEnvelope {
  return {
    schemaVersion: 2,
    id: options.id ?? randomUUID(),
    type: "runtime.conversation_asset",
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    conversationId: requiredString(options.conversationId, "conversationId"),
    correlationId: requiredString(options.correlationId, "correlationId"),
    idempotencyKey: requiredString(options.idempotencyKey, "idempotencyKey"),
    payload
  };
}

export function decodeConversationAsset(value: unknown): ConversationAssetOutboxPayload {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw contractError("contract_version_unsupported", "conversation_asset 必须使用版本化持久化消息。");
  }
  exactKeys(value, [
    "schemaVersion",
    "id",
    "type",
    "occurredAt",
    "conversationId",
    "correlationId",
    "idempotencyKey",
    "payload"
  ], "conversation_asset envelope");
  if (value.type !== "runtime.conversation_asset" || !isRecord(value.payload)) {
    throw contractError("contract_type_invalid", "持久化消息类型与 runtime.conversation_asset 不匹配。");
  }
  boundedRequiredString(value.id, "id", 128);
  boundedRequiredString(value.occurredAt, "occurredAt", 64);
  boundedRequiredString(value.correlationId, "correlationId", 128);
  if (typeof value.idempotencyKey !== "string" || !/^conversation-asset:[a-f0-9]{64}$/.test(value.idempotencyKey)) {
    throw contractError("contract_field_invalid", "持久化消息字段 idempotencyKey 无效。");
  }

  const payload = value.payload;
  exactKeys(payload, [
    "type",
    "target",
    "incomingFingerprint",
    "toolName",
    "asset",
    "logRunId",
    "replyGate"
  ], "conversation_asset payload");
  if (payload.type !== "conversation_asset") {
    throw contractError("contract_type_invalid", "持久化消息 payload 类型无效。");
  }
  const target = decodeConversationAssetTarget(payload.target);
  const conversationId = target.conversationId;
  const logRunId = requiredString(payload.logRunId, "logRunId");
  if (!boundedSnapshotString(logRunId, 128)) {
    throw contractError("contract_field_invalid", "持久化消息字段 logRunId 无效。");
  }
  if (value.conversationId !== conversationId) {
    throw contractError("contract_field_invalid", "持久化消息字段 conversationId 与入站目标不匹配。");
  }
  if (value.correlationId !== logRunId) {
    throw contractError("contract_field_invalid", "持久化消息字段 correlationId 与 logRunId 不匹配。");
  }
  if (typeof payload.incomingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.incomingFingerprint)) {
    throw contractError("contract_field_invalid", "持久化消息字段 incomingFingerprint 无效。");
  }
  const replyGate = decodeConversationAssetReplyGate(payload.replyGate, target);
  if (!isRecord(payload.asset)) {
    throw contractError("contract_field_invalid", "持久化消息字段 asset 无效。");
  }
  const asset = payload.asset;
  exactKeys(asset, ["path", "kind", "name", "byteLength", "sha256", "rootIdentity"], "asset");
  const assetPath = requiredString(asset.path, "asset.path");
  if (!isSafeRelativeAssetPath(assetPath)) {
    throw contractError("contract_field_invalid", "持久化消息字段 asset.path 无效。");
  }
  const kind = asset.kind;
  if (kind !== "file" && kind !== "image" && kind !== "voice") {
    throw contractError("contract_field_invalid", "持久化消息字段 asset.kind 无效。");
  }
  const toolName = payload.toolName;
  if (
    (toolName !== "send_file" && toolName !== "send_voice_message") ||
    (toolName === "send_file" && kind === "voice") ||
    (toolName === "send_voice_message" && kind !== "voice")
  ) {
    throw contractError("contract_field_invalid", "持久化消息字段 toolName 无效。");
  }
  const name = requiredString(asset.name, "asset.name");
  if (
    name === "." ||
    name === ".." ||
    name.length > 255 ||
    /[\0-\x1f\x7f/\\]/.test(name) ||
    path.basename(name) !== name
  ) {
    throw contractError("contract_field_invalid", "持久化消息字段 asset.name 无效。");
  }
  if (!Number.isSafeInteger(asset.byteLength) || Number(asset.byteLength) < 0 || Number(asset.byteLength) > 32 * 1024 * 1024) {
    throw contractError("contract_field_invalid", "持久化消息字段 asset.byteLength 无效。");
  }
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw contractError("contract_field_invalid", "持久化消息字段 asset.sha256 无效。");
  }
  const rootIdentity = decodeQueuedConversationAssetRootIdentity(asset.rootIdentity);
  return {
    type: "conversation_asset",
    target,
    incomingFingerprint: payload.incomingFingerprint,
    toolName,
    asset: {
      path: assetPath,
      kind,
      name,
      byteLength: Number(asset.byteLength),
      sha256: asset.sha256,
      rootIdentity
    },
    logRunId,
    replyGate
  };
}

function decodeConversationAssetReplyGate(
  value: unknown,
  target: ConversationAssetTargetV1
): ReplyGateSnapshotV1 {
  if (!isRecord(value)) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate 无效。");
  }
  exactKeys(value, [
    "generation",
    "scope",
    "conversationId",
    "scopeEpoch",
    "conversationEpoch"
  ], "replyGate");
  if (!boundedSnapshotString(value.generation, 128)) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate.generation 无效。");
  }
  if (value.scope !== target.scope) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate.scope 与入站范围不匹配。");
  }
  if (value.conversationId !== target.conversationId) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate.conversationId 与入站目标不匹配。");
  }
  if (!nonNegativeInteger(value.scopeEpoch)) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate.scopeEpoch 无效。");
  }
  if (!nonNegativeInteger(value.conversationEpoch)) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate.conversationEpoch 无效。");
  }
  return {
    generation: value.generation,
    scope: target.scope,
    conversationId: target.conversationId,
    scopeEpoch: Number(value.scopeEpoch),
    conversationEpoch: Number(value.conversationEpoch)
  };
}

function decodeConversationAssetTarget(value: unknown): ConversationAssetTargetV1 {
  if (!isRecord(value)) {
    throw contractError("contract_field_invalid", "持久化消息字段 target 无效。");
  }
  exactKeys(value, [
    "transport",
    "agentId",
    "accountId",
    "scope",
    "userId",
    "groupId",
    "messageId",
    "selfId",
    "conversationId"
  ], "target");
  if (value.transport !== "onebot") {
    throw contractError("contract_field_invalid", "持久化消息字段 target.transport 无效。");
  }
  if (!boundedSnapshotString(value.agentId, 128)) {
    throw contractError("contract_field_invalid", "持久化消息字段 target.agentId 无效。");
  }
  if (typeof value.accountId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.accountId)) {
    throw contractError("contract_field_invalid", "持久化消息字段 target.accountId 无效。");
  }
  if (value.scope !== "private" && value.scope !== "user_group" && value.scope !== "bot_group") {
    throw contractError("contract_field_invalid", "持久化消息字段 target.scope 无效。");
  }
  if (!positiveSafeInteger(value.userId)) {
    throw contractError("contract_field_invalid", "持久化消息字段 target.userId 无效。");
  }
  const groupId = nullablePositiveSafeInteger(value.groupId, "target.groupId");
  const messageId = nullablePositiveSafeInteger(value.messageId, "target.messageId");
  const selfId = nullablePositiveSafeInteger(value.selfId, "target.selfId");
  if ((value.scope === "private" && groupId !== null) || (value.scope !== "private" && groupId === null)) {
    throw contractError("contract_field_invalid", "持久化消息字段 target.groupId 与 scope 不匹配。");
  }
  if (!boundedSnapshotString(value.conversationId, 256)) {
    throw contractError("contract_field_invalid", "持久化消息字段 target.conversationId 无效。");
  }
  const localId = groupId === null ? `private:${value.userId}` : `group:${groupId}`;
  const expectedConversationId = value.accountId === "primary"
    ? localId
    : `account:${value.accountId}:${localId}`;
  if (value.conversationId !== expectedConversationId) {
    throw contractError("contract_field_invalid", "持久化消息字段 target.conversationId 与目标不匹配。");
  }
  return {
    transport: "onebot",
    agentId: value.agentId,
    accountId: value.accountId,
    scope: value.scope,
    userId: Number(value.userId),
    groupId,
    messageId,
    selfId,
    conversationId: value.conversationId
  };
}

function decodeQueuedConversationAssetRootIdentity(value: unknown): QueuedConversationAssetRootIdentityV1 {
  if (!isRecord(value)) {
    throw contractError("contract_field_invalid", "持久化消息字段 asset.rootIdentity 无效。");
  }
  exactKeys(value, ["dev", "ino", "ctimeNs"], "asset.rootIdentity");
  const dev = boundedDecimal(value.dev, "asset.rootIdentity.dev", true);
  const ino = boundedDecimal(value.ino, "asset.rootIdentity.ino", false);
  const ctimeNs = boundedDecimal(value.ctimeNs, "asset.rootIdentity.ctimeNs", false);
  return { dev, ino, ctimeNs };
}

function contractError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  return value;
}

function boundedRequiredString(value: unknown, name: string, maxLength: number) {
  if (!boundedSnapshotString(value, maxLength)) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 包含缺失或未知字段。`);
  }
}

function nullablePositiveSafeInteger(value: unknown, name: string) {
  if (value === null) return null;
  if (!positiveSafeInteger(value)) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  return Number(value);
}

function boundedDecimal(value: unknown, name: string, allowZero: boolean) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/.test(value)) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  const number = BigInt(value);
  if (number > 18_446_744_073_709_551_615n || (!allowZero && number === 0n)) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  return value;
}

function isSafeRelativeAssetPath(value: string) {
  if (value.length > 1_024 || value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedSnapshotString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && Array.from(value).length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function positiveSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
