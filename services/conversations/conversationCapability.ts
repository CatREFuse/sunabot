import type { AgentWorkbenchBackend } from "../../packages/platform/agentResourceLayout.js";

export interface ConversationCapabilityContextV1 {
  schemaVersion: 1;
  agentId: string;
  accountId: string;
  conversationId: string;
  transport: "onebot" | "web";
  scope: "private" | "user_group" | "bot_group";
  userId: number;
  isAdmin: boolean;
  messageId?: number;
  configEpoch: number;
}

export type ConversationWorkbenchPurpose =
  | "chat_media_export"
  | "catalog_import"
  | "read_file"
  | "write_file"
  | "bash_native"
  | "bash_docker"
  | "send_file"
  | "portable_knowledge_read"
  | "image_reference"
  | "codex_input"
  | "codex_artifact"
  | "system_voice_asset";

export interface ConversationWorkbenchPlan {
  purpose: ConversationWorkbenchPurpose;
  primaryBackend: AgentWorkbenchBackend;
  readableBackends: readonly AgentWorkbenchBackend[];
  writableBackends: readonly AgentWorkbenchBackend[];
  fallbackPolicy: "none" | "source_missing_only";
  nativeProjection: "none" | "read_only";
  pathPolicy: "workbench_relative" | "native_knowledge_relative";
}

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CONVERSATION_ID_PATTERN =
  /^(?:account:[A-Za-z0-9_-]{1,64}:)?(?:private|group):[1-9]\d*$|^web:admin$/u;
const WORKBENCH_PURPOSES = new Set<ConversationWorkbenchPurpose>([
  "chat_media_export",
  "catalog_import",
  "read_file",
  "write_file",
  "bash_native",
  "bash_docker",
  "send_file",
  "portable_knowledge_read",
  "image_reference",
  "codex_input",
  "codex_artifact",
  "system_voice_asset"
]);

export function createConversationCapabilityContext(
  input: Omit<ConversationCapabilityContextV1, "schemaVersion">
): Readonly<ConversationCapabilityContextV1> {
  if (
    !AGENT_ID_PATTERN.test(input.agentId)
    || !ACCOUNT_ID_PATTERN.test(input.accountId)
    || !CONVERSATION_ID_PATTERN.test(input.conversationId)
    || (input.transport !== "onebot" && input.transport !== "web")
    || !["private", "user_group", "bot_group"].includes(input.scope)
    || !Number.isSafeInteger(input.userId)
    || input.userId <= 0
    || typeof input.isAdmin !== "boolean"
    || !Number.isSafeInteger(input.configEpoch)
    || input.configEpoch < 0
    || (
      input.messageId !== undefined
      && (!Number.isSafeInteger(input.messageId) || input.messageId <= 0)
    )
    || (input.transport === "onebot" && input.messageId === undefined)
    || !conversationIdentityMatches(input)
  ) {
    throw conversationCapabilityError();
  }
  return Object.freeze({
    schemaVersion: 1,
    agentId: input.agentId,
    accountId: input.accountId,
    conversationId: input.conversationId,
    transport: input.transport,
    scope: input.scope,
    userId: input.userId,
    isAdmin: input.isAdmin,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    configEpoch: input.configEpoch
  });
}

export function resolveConversationWorkbench(
  context: Readonly<ConversationCapabilityContextV1>,
  purpose: ConversationWorkbenchPurpose
): Readonly<ConversationWorkbenchPlan> {
  assertCapabilityContext(context);
  if (!WORKBENCH_PURPOSES.has(purpose)) throw conversationCapabilityError();
  const administratorPrivate = context.isAdmin && context.scope === "private";

  if (purpose === "portable_knowledge_read") {
    return frozenPlan({
      purpose,
      primaryBackend: "native",
      readableBackends: ["native"],
      writableBackends: [],
      fallbackPolicy: "none",
      nativeProjection: context.transport === "onebot" && !administratorPrivate
        ? "read_only"
        : "none",
      pathPolicy: "native_knowledge_relative"
    });
  }
  if (purpose === "system_voice_asset") {
    return frozenPlan({
      purpose,
      primaryBackend: "native",
      readableBackends: ["native"],
      writableBackends: ["native"],
      fallbackPolicy: "none",
      nativeProjection: "none",
      pathPolicy: "workbench_relative"
    });
  }
  if (purpose === "bash_native") {
    if (!administratorPrivate) throw conversationCapabilityError();
    return exactPlan(purpose, "native");
  }
  if (purpose === "bash_docker") {
    if (context.transport === "web" && !administratorPrivate) {
      throw conversationCapabilityError();
    }
    return exactPlan(purpose, "docker", context.transport === "onebot" ? "read_only" : "none");
  }
  if (purpose === "read_file" || purpose === "write_file") {
    if (context.transport !== "onebot" || !administratorPrivate) {
      throw conversationCapabilityError();
    }
    return exactPlan(purpose, "native");
  }
  if (
    context.transport === "web"
    && administratorPrivate
    && (purpose === "codex_input" || purpose === "codex_artifact")
  ) {
    return exactPlan(purpose, "native");
  }
  if (context.transport !== "onebot") throw conversationCapabilityError();

  const primaryBackend: AgentWorkbenchBackend = administratorPrivate ? "native" : "docker";
  if (purpose === "send_file" && primaryBackend === "native") {
    return frozenPlan({
      purpose,
      primaryBackend,
      readableBackends: ["native", "docker"],
      writableBackends: ["native"],
      fallbackPolicy: "source_missing_only",
      nativeProjection: "none",
      pathPolicy: "workbench_relative"
    });
  }
  return exactPlan(
    purpose,
    primaryBackend,
    primaryBackend === "docker" ? "read_only" : "none"
  );
}

function conversationIdentityMatches(
  input: Omit<ConversationCapabilityContextV1, "schemaVersion">
) {
  if (input.transport === "web") {
    return input.accountId === "web-admin"
      && input.conversationId === "web:admin"
      && input.scope === "private"
      && input.isAdmin;
  }
  const localKind = input.scope === "private" ? "private" : "group";
  const prefix = input.accountId === "primary" ? "" : `account:${input.accountId}:`;
  return new RegExp(`^${prefix}${localKind}:[1-9]\\d*$`, "u").test(input.conversationId);
}

function exactPlan(
  purpose: ConversationWorkbenchPurpose,
  backend: AgentWorkbenchBackend,
  nativeProjection: ConversationWorkbenchPlan["nativeProjection"] = "none"
) {
  return frozenPlan({
    purpose,
    primaryBackend: backend,
    readableBackends: [backend],
    writableBackends: [backend],
    fallbackPolicy: "none",
    nativeProjection,
    pathPolicy: "workbench_relative"
  });
}

function frozenPlan(plan: ConversationWorkbenchPlan): Readonly<ConversationWorkbenchPlan> {
  return Object.freeze({
    ...plan,
    readableBackends: Object.freeze([...plan.readableBackends]),
    writableBackends: Object.freeze([...plan.writableBackends])
  });
}

function assertCapabilityContext(context: Readonly<ConversationCapabilityContextV1>) {
  if (
    context.schemaVersion !== 1
    || createConversationCapabilityContext({
      agentId: context.agentId,
      accountId: context.accountId,
      conversationId: context.conversationId,
      transport: context.transport,
      scope: context.scope,
      userId: context.userId,
      isAdmin: context.isAdmin,
      messageId: context.messageId,
      configEpoch: context.configEpoch
    }).schemaVersion !== 1
  ) {
    throw conversationCapabilityError();
  }
}

function conversationCapabilityError() {
  return Object.assign(new Error("CONVERSATION_CAPABILITY_INVALID"), {
    code: "CONVERSATION_CAPABILITY_INVALID"
  });
}
