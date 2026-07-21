export const SYSTEM_CONFIG_TOOL_NAME = "system_config";

export const SYSTEM_CONFIG_OPERATIONS = [
  "get_settings",
  "get_status",
  "list_groups",
  "set_auto_reply",
  "set_orchestrator",
  "set_search",
  "set_group_reply"
] as const;

export type SystemConfigOperation = (typeof SYSTEM_CONFIG_OPERATIONS)[number];
export type SystemConfigMutationOperation = Exclude<
  SystemConfigOperation,
  "get_settings" | "get_status" | "list_groups"
>;
export type SystemConfigReplyScope = "all" | "private" | "user_group" | "bot_group";
export type SystemConfigSearchImplementation = "tavily";
export type SystemConfigBashAdminBackend = "native" | "docker";

export interface SystemConfigInput {
  operation: SystemConfigOperation;
  replyScope: SystemConfigReplyScope | null;
  enabled: boolean | null;
  orchestratorEnabled: boolean | null;
  searchImplementation: SystemConfigSearchImplementation | null;
  bashAdminBackend: SystemConfigBashAdminBackend | null;
  conversationId: string | null;
  groupCursor: string | null;
  groupLimit: number | null;
}

export interface SystemConfigToolPort {
  execute(input: SystemConfigInput): Promise<unknown>;
  mutationStaged(): boolean;
  rejectTurn(): void;
  turnRejected(): boolean;
}

export interface SystemConfigMutationDescriptor {
  action: SystemConfigMutationOperation;
  normalizedInput: SystemConfigInput;
  closesCurrentPrivateReplyGate: boolean;
}

export interface SystemConfigTurn extends SystemConfigToolPort {
  stagedMutation(): SystemConfigMutationDescriptor | undefined;
  commit(): Promise<void>;
  discard(): void;
}

export interface SystemConfigTurnContext {
  agentId: string;
  conversationId: string;
  promptToolNames: readonly string[];
}

export interface SystemConfigRuntimePort {
  createTurn(context: SystemConfigTurnContext): SystemConfigTurn;
}

export const systemConfigTool = {
  type: "function",
  name: SYSTEM_CONFIG_TOOL_NAME,
  description: [
    "Read the current Agent's safe behavior settings or sanitized system status, and change only the allowed reply, orchestrator, search, or known-group settings.",
    "This tool is available only in an administrator private chat or administrator Web Chat.",
    "A change is validated immediately and takes effect after the current confirmation reply is queued; report it as effective from the next turn.",
    "Call get_settings before changing an unfamiliar option. The only currently supported search implementation is tavily."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: SYSTEM_CONFIG_OPERATIONS,
        description: "The read or mutation operation to perform."
      },
      replyScope: {
        type: ["string", "null"],
        enum: ["all", "private", "user_group", "bot_group", null],
        description: "Required only for set_auto_reply; use all to update all three reply scopes."
      },
      enabled: {
        type: ["boolean", "null"],
        description: "The requested enabled state for set_auto_reply, set_orchestrator, set_search, or the group reply switch."
      },
      orchestratorEnabled: {
        type: ["boolean", "null"],
        description: "Optional per-group orchestrator state for set_group_reply; null keeps the current value."
      },
      searchImplementation: {
        type: ["string", "null"],
        enum: ["tavily", null],
        description: "Search implementation for set_search; null keeps the current implementation."
      },
      bashAdminBackend: {
        type: "null",
        enum: [null],
        description: "Reserved compatibility field. Always use null; Bash routing is fixed."
      },
      conversationId: {
        type: ["string", "null"],
        maxLength: 160,
        description: "Existing full known group conversationId from get_settings or list_groups; use list_groups when the group is outside the settings summary. Required only for set_group_reply."
      },
      groupCursor: {
        type: ["string", "null"],
        maxLength: 160,
        description: "Full group conversationId returned as the previous list_groups nextCursor."
      },
      groupLimit: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 100,
        description: "Page size for list_groups; null uses 50."
      }
    },
    required: [
      "operation",
      "replyScope",
      "enabled",
      "orchestratorEnabled",
      "searchImplementation",
      "bashAdminBackend",
      "conversationId",
      "groupCursor",
      "groupLimit"
    ]
  },
  strict: true
} as const;

export async function runSystemConfig(input: unknown, port: SystemConfigToolPort) {
  const parsed = parseSystemConfigInput(input);
  if (!parsed.ok) return parsed;
  return port.execute(parsed.input);
}

export function parseSystemConfigInput(input: unknown):
  | { ok: true; input: SystemConfigInput }
  | { ok: false; code: "SYSTEM_CONFIG_INVALID"; error: string; field?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("System configuration arguments must be an object.");
  }
  const value = input as Record<string, unknown>;
  const allowedKeys = new Set([
    "operation",
    "replyScope",
    "enabled",
    "orchestratorEnabled",
    "searchImplementation",
    "bashAdminBackend",
    "conversationId",
    "groupCursor",
    "groupLimit"
  ]);
  const extra = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (extra) return invalid("Unsupported system configuration argument.", extra);
  if (!SYSTEM_CONFIG_OPERATIONS.includes(value.operation as SystemConfigOperation)) {
    return invalid("Unsupported system configuration operation.", "operation");
  }

  const replyScope = value.replyScope;
  if (replyScope !== null && !["all", "private", "user_group", "bot_group"].includes(String(replyScope))) {
    return invalid("Invalid auto-reply scope.", "replyScope");
  }
  const enabled = nullableBoolean(value.enabled);
  if (!enabled.ok) return invalid("enabled must be a boolean or null.", "enabled");
  const orchestratorEnabled = nullableBoolean(value.orchestratorEnabled);
  if (!orchestratorEnabled.ok) {
    return invalid("orchestratorEnabled must be a boolean or null.", "orchestratorEnabled");
  }
  if (value.searchImplementation !== null && value.searchImplementation !== "tavily") {
    return invalid("Unsupported search implementation.", "searchImplementation");
  }
  if (value.bashAdminBackend !== null) {
    return invalid("Bash routing is fixed; bashAdminBackend must be null.", "bashAdminBackend");
  }
  const conversationId = value.conversationId === null
    ? null
    : typeof value.conversationId === "string"
      ? value.conversationId.trim()
      : undefined;
  if (conversationId === undefined || (conversationId?.length ?? 0) > 160) {
    return invalid("conversationId must be a string or null.", "conversationId");
  }
  const groupCursor = value.groupCursor === null
    ? null
    : typeof value.groupCursor === "string"
      ? value.groupCursor.trim()
      : undefined;
  if (
    groupCursor === undefined ||
    (groupCursor?.length ?? 0) > 160 ||
    (groupCursor !== null && !GROUP_CONVERSATION_ID.test(groupCursor))
  ) {
    return invalid("groupCursor must be a full group conversationId or null.", "groupCursor");
  }
  const groupLimit = value.groupLimit === null
    ? null
    : typeof value.groupLimit === "number" && Number.isInteger(value.groupLimit) &&
        value.groupLimit >= 1 && value.groupLimit <= 100
      ? value.groupLimit
      : undefined;
  if (groupLimit === undefined) {
    return invalid("groupLimit must be an integer from 1 to 100 or null.", "groupLimit");
  }

  const parsed: SystemConfigInput = {
    operation: value.operation as SystemConfigOperation,
    replyScope: replyScope as SystemConfigReplyScope | null,
    enabled: enabled.value,
    orchestratorEnabled: orchestratorEnabled.value,
    searchImplementation: value.searchImplementation as SystemConfigSearchImplementation | null,
    bashAdminBackend: value.bashAdminBackend as SystemConfigBashAdminBackend | null,
    conversationId,
    groupCursor,
    groupLimit
  };
  const shapeError = validateOperationShape(parsed);
  return shapeError ?? { ok: true, input: parsed };
}

function validateOperationShape(input: SystemConfigInput) {
  const unused = (
    replyScope: SystemConfigReplyScope | null,
    enabled: boolean | null,
    orchestratorEnabled: boolean | null,
    searchImplementation: SystemConfigSearchImplementation | null,
    bashAdminBackend: SystemConfigBashAdminBackend | null,
    conversationId: string | null,
    groupCursor: string | null,
    groupLimit: number | null
  ) => replyScope === null && enabled === null && orchestratorEnabled === null &&
    searchImplementation === null && bashAdminBackend === null && conversationId === null &&
    groupCursor === null && groupLimit === null;

  if (input.operation === "get_settings" || input.operation === "get_status") {
    return unused(
      input.replyScope,
      input.enabled,
      input.orchestratorEnabled,
      input.searchImplementation,
      input.bashAdminBackend,
      input.conversationId,
      input.groupCursor,
      input.groupLimit
    ) ? undefined : invalid("Read operations do not accept mutation values.", input.operation);
  }
  if (input.operation === "list_groups") {
    return input.replyScope === null && input.enabled === null && input.orchestratorEnabled === null &&
      input.searchImplementation === null && input.bashAdminBackend === null && input.conversationId === null
      ? undefined
      : invalid("list_groups accepts only groupCursor and groupLimit.", "list_groups");
  }
  if (input.operation === "set_auto_reply") {
    return input.replyScope && input.enabled !== null && input.orchestratorEnabled === null &&
      input.searchImplementation === null && input.bashAdminBackend === null && input.conversationId === null &&
      input.groupCursor === null && input.groupLimit === null
      ? undefined
      : invalid("set_auto_reply requires replyScope and enabled only.", "set_auto_reply");
  }
  if (input.operation === "set_orchestrator") {
    return input.replyScope === null && input.enabled !== null && input.orchestratorEnabled === null &&
      input.searchImplementation === null && input.bashAdminBackend === null && input.conversationId === null &&
      input.groupCursor === null && input.groupLimit === null
      ? undefined
      : invalid("set_orchestrator requires enabled only.", "set_orchestrator");
  }
  if (input.operation === "set_search") {
    return input.replyScope === null && input.enabled !== null && input.orchestratorEnabled === null &&
      input.bashAdminBackend === null && input.conversationId === null && input.groupCursor === null &&
      input.groupLimit === null
      ? undefined
      : invalid("set_search accepts enabled and an optional searchImplementation only.", "set_search");
  }
  return input.replyScope === null && input.conversationId !== null &&
    (input.enabled !== null || input.orchestratorEnabled !== null) && input.searchImplementation === null &&
    input.bashAdminBackend === null && input.groupCursor === null && input.groupLimit === null
    ? undefined
    : invalid(
      "set_group_reply requires an existing conversationId and at least one group switch.",
      "set_group_reply"
    );
}

const GROUP_CONVERSATION_ID = /^(?:account:[A-Za-z0-9_-]+:)?group:\d+$/;

function nullableBoolean(value: unknown): { ok: true; value: boolean | null } | { ok: false } {
  return value === null || typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false };
}

function invalid(error: string, field?: string) {
  return {
    ok: false as const,
    code: "SYSTEM_CONFIG_INVALID" as const,
    error,
    ...(field ? { field } : {})
  };
}
