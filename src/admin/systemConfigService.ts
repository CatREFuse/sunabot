import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import type {
  SystemConfigInput,
  SystemConfigMutationDescriptor,
  SystemConfigTurn,
  SystemConfigTurnContext
} from "../../services/tools/systemConfigTool.js";
import type { AppConfig, ConversationRecord } from "../types.js";
import type { WorkspaceBashUnavailableReason } from "../../services/tools/bashCapability.js";
import type { AgentConfigService } from "./agentConfigService.js";
import { configRevision } from "./configRevision.js";

const GROUP_LIMIT = 100;
const GROUP_PAGE_DEFAULT_LIMIT = 50;
const GROUP_CONVERSATION_ID = /^(?:account:[A-Za-z0-9_-]+:)?group:\d+$/;
const WEB_CHAT_CONVERSATION_ID = "web:admin";
const DURABLE_DELIVERY_REQUIRED_CODE = "SYSTEM_CONFIG_DURABLE_DELIVERY_REQUIRED";
const DURABLE_DELIVERY_REQUIRED_MESSAGE = "Web Chat 暂不支持修改系统设置，请在管理员 QQ 私聊中操作。";

export interface SystemConfigRuntime {
  getConversationRecords(): ConversationRecord[];
  getPersonaStatus(): unknown;
  getProviderStatus(): unknown;
  resolveToolCapabilities(): Promise<{
    workspaceBash: boolean;
    workspaceBashReason?: WorkspaceBashUnavailableReason;
  }>;
  setConversationReplyEnabled(input: {
    id: string;
    replyEnabled?: boolean;
    orchestratorEnabled?: boolean;
  }): ConversationRecord;
}

export interface SystemConfigServiceOptions {
  registry: Pick<AgentRegistry, "config" | "get">;
  agentConfigService: Pick<AgentConfigService, "readEnvelope" | "patch">;
  getRuntime(agentId: string): SystemConfigRuntime;
  getOnebotStatus(agentId: string): unknown;
  getRuntimeProbe(agentId: string): Promise<unknown>;
  getRecoveryStatus(): unknown;
  startedAt: string;
  now?: () => Date;
}

interface PendingMutation {
  descriptor: SystemConfigMutationDescriptor;
  commit(): Promise<void>;
}

export class SystemConfigService {
  private readonly now: () => Date;

  constructor(private readonly options: SystemConfigServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  createTurn(context: SystemConfigTurnContext): SystemConfigTurn {
    let pending: PendingMutation | undefined;
    return {
      execute: async (input) => {
        if (context.conversationId === WEB_CHAT_CONVERSATION_ID && isMutation(input)) {
          return failure(DURABLE_DELIVERY_REQUIRED_CODE, DURABLE_DELIVERY_REQUIRED_MESSAGE);
        }
        if (input.operation === "get_settings") return this.settings(context);
        if (input.operation === "get_status") return this.status(context);
        if (input.operation === "list_groups") return this.groups(context, input);
        if (pending) return failure("SYSTEM_CONFIG_MUTATION_PENDING", "当前回合已有一项待提交的配置修改。");
        const prepared = await this.prepareMutation(context, input);
        if ("pending" in prepared && prepared.pending) pending = prepared.pending;
        return prepared.result;
      },
      mutationStaged: () => Boolean(pending),
      stagedMutation: () => pending ? structuredClone(pending.descriptor) : undefined,
      commit: async () => {
        const mutation = pending;
        if (!mutation) return;
        await mutation.commit();
        pending = undefined;
      },
      discard: () => {
        pending = undefined;
      }
    };
  }

  private async settings(context: SystemConfigTurnContext) {
    const runtime = this.options.getRuntime(context.agentId);
    const [agent, config, envelope, toolCapabilities] = await Promise.all([
      this.options.registry.get(context.agentId),
      this.options.registry.config(context.agentId),
      this.options.agentConfigService.readEnvelope(context.agentId),
      safeToolCapabilities(runtime)
    ]);
    const records = knownGroupRecords(runtime);
    const groups = records.slice(0, GROUP_LIMIT).map(safeGroup);
    const searchOverride = config.bot.tools.overrides?.websearch?.enabled;
    const promptEnabled = context.promptToolNames.includes("websearch");
    const credentialConfigured = envelope.fieldStates["bot.tools.websearch.tavilyApiKeyEnv"]
      ?.secretConfigured === true;
    return {
      ok: true,
      operation: "get_settings",
      agent: { id: agent.id, name: agent.name },
      autoReply: {
        private: config.onebot.autoReplyPrivate,
        userGroup: config.onebot.autoReplyUserGroup,
        botGroup: config.onebot.autoReplyBotGroup
      },
      orchestrator: {
        enabled: config.bot.orchestrator.enabled,
        model: config.bot.orchestrator.userGroupchatOrchestratorModel,
        messageThreshold: config.bot.orchestrator.messageThreshold,
        recentMessageWindowMs: config.bot.orchestrator.recentMessageWindowMs,
        scope: "ambient_group_replies"
      },
      search: {
        implementation: config.bot.tools.websearch.provider,
        availableImplementations: ["tavily"],
        configuredEnabled: searchOverride ?? null,
        promptEnabled,
        credentialConfigured,
        effectiveEnabled: (searchOverride ?? promptEnabled) && credentialConfigured,
        maxResults: config.bot.tools.websearch.maxResults
      },
      replyBehavior: {
        replyDebounceMs: config.bot.replyDebounceMs,
        pokeOnNoReply: config.bot.pokeOnNoReply,
        quoteGroupReplies: config.bot.quoteGroupReplies,
        contextMessageLimit: config.bot.contextMessageLimit
      },
      tone: {
        enabled: config.bot.tone.enabled,
        segmentedReply: config.bot.tone.segmentedReply,
        followMainModel: config.bot.tone.followMainModel,
        providerId: config.bot.tone.providerId || null,
        model: config.bot.tone.model,
        reasoningEffort: config.bot.tone.reasoningEffort ?? null,
        temperature: config.bot.tone.temperature,
        maxOutputTokens: config.bot.tone.maxOutputTokens,
        maxRetries: config.bot.tone.maxRetries
      },
      memory: {
        model: config.bot.memory.memoryModel,
        dreamRecentWindowHours: config.bot.memory.dreamRecentWindowHours,
        dreamRecentMemoryLimit: config.bot.memory.dreamRecentMemoryLimit,
        dreamOlderMemoryLimit: config.bot.memory.dreamOlderMemoryLimit
      },
      tools: {
        maxCalls: config.bot.tools.maxCalls,
        configuredEnabled: configuredToolStates(config)
      },
      bash: safeBashSettings(config, toolCapabilities),
      system: safeSystemSettings(config, envelope.fieldStates),
      groups: {
        total: records.length,
        truncated: records.length > groups.length,
        items: groups
      },
      options: {
        replyScopes: ["all", "private", "user_group", "bot_group"],
        searchImplementations: ["tavily"]
      }
    };
  }

  private async status(context: SystemConfigTurnContext) {
    const runtime = this.options.getRuntime(context.agentId);
    const [config, probe, onebot, toolCapabilities] = await Promise.all([
      this.options.registry.config(context.agentId),
      this.options.getRuntimeProbe(context.agentId),
      Promise.resolve(this.options.getOnebotStatus(context.agentId)),
      safeToolCapabilities(runtime)
    ]);
    const startedAtMs = Date.parse(this.options.startedAt);
    const uptimeSeconds = Number.isFinite(startedAtMs)
      ? Math.max(0, Math.floor((this.now().getTime() - startedAtMs) / 1_000))
      : 0;
    return {
      ok: true,
      operation: "get_status",
      agentId: context.agentId,
      startedAt: this.options.startedAt,
      uptimeSeconds,
      onebot: safeOnebotStatus(onebot),
      persona: safePersonaStatus(runtime.getPersonaStatus()),
      provider: safeProviderStatus(runtime.getProviderStatus()),
      bash: safeBashSettings(config, toolCapabilities),
      recovery: { required: asRecord(this.options.getRecoveryStatus()).required === true },
      probe: safeProbe(probe)
    };
  }

  private groups(context: SystemConfigTurnContext, input: SystemConfigInput) {
    const cursor = input.groupCursor;
    const limit = input.groupLimit ?? GROUP_PAGE_DEFAULT_LIMIT;
    const records = knownGroupRecords(this.options.getRuntime(context.agentId))
      .sort(compareConversationIds);
    const candidates = records
      .filter((record) => cursor === null || record.id > cursor)
      .slice(0, limit + 1);
    const hasMore = candidates.length > limit;
    const items = candidates.slice(0, limit).map(safeGroup);
    return {
      ok: true,
      operation: "list_groups",
      total: records.length,
      items,
      nextCursor: hasMore ? items.at(-1)!.conversationId : null,
      hasMore
    };
  }

  private async prepareMutation(context: SystemConfigTurnContext, input: SystemConfigInput) {
    if (input.operation === "set_group_reply") return this.prepareGroupMutation(context, input);
    const config = await this.options.registry.config(context.agentId);
    if (input.operation === "set_auto_reply") return this.prepareAutoReply(context.agentId, config, input);
    if (input.operation === "set_orchestrator") return this.prepareOrchestrator(context.agentId, config, input);
    return this.prepareSearch(context.agentId, config, input);
  }

  private prepareAutoReply(agentId: string, config: AppConfig, input: SystemConfigInput) {
    const before = {
      private: config.onebot.autoReplyPrivate,
      userGroup: config.onebot.autoReplyUserGroup,
      botGroup: config.onebot.autoReplyBotGroup
    };
    const after = { ...before };
    if (input.replyScope === "all" || input.replyScope === "private") after.private = input.enabled!;
    if (input.replyScope === "all" || input.replyScope === "user_group") after.userGroup = input.enabled!;
    if (input.replyScope === "all" || input.replyScope === "bot_group") after.botGroup = input.enabled!;
    const changes = changedFields(before, after, "autoReply");
    if (!changes.length) return noOp("set_auto_reply", before, after);
    const { quoteGroupReplies: _mirror, ...onebot } = structuredClone(config.onebot);
    onebot.autoReplyPrivate = after.private;
    onebot.autoReplyUserGroup = after.userGroup;
    onebot.autoReplyBotGroup = after.botGroup;
    return staged(input, before, after, changes, async () => {
      await this.options.agentConfigService.patch(agentId, "onebot", {
        revision: configRevision(config),
        value: onebot
      });
    }, {}, before.private && !after.private);
  }

  private prepareOrchestrator(agentId: string, config: AppConfig, input: SystemConfigInput) {
    const before = { enabled: config.bot.orchestrator.enabled };
    const after = { enabled: input.enabled! };
    const changes = changedFields(before, after, "orchestrator");
    if (!changes.length) return noOp("set_orchestrator", before, after, {
      scope: "ambient_group_replies"
    });
    const orchestrator = structuredClone(config.bot.orchestrator);
    orchestrator.enabled = after.enabled;
    return staged(input, before, after, changes, async () => {
      await this.options.agentConfigService.patch(agentId, "orchestrator", {
        revision: configRevision(config),
        value: orchestrator
      });
    }, {
      scope: "ambient_group_replies"
    });
  }

  private prepareSearch(agentId: string, config: AppConfig, input: SystemConfigInput) {
    if (input.searchImplementation != null && input.searchImplementation !== "tavily") {
      return { result: failure("SYSTEM_CONFIG_SEARCH_UNSUPPORTED", "当前仅支持 Tavily 搜索实现。") };
    }
    const before = {
      enabled: config.bot.tools.overrides?.websearch?.enabled ?? null,
      implementation: config.bot.tools.websearch.provider
    };
    const after = { enabled: input.enabled!, implementation: "tavily" as const };
    const changes = changedFields(before, after, "search");
    if (!changes.length) return noOp("set_search", before, after, {
      availableImplementations: ["tavily"]
    });
    const tools = structuredClone(config.bot.tools);
    tools.overrides = {
      ...(tools.overrides ?? {}),
      websearch: {
        ...(tools.overrides?.websearch ?? {}),
        enabled: after.enabled
      }
    };
    tools.websearch.provider = "tavily";
    return staged(input, before, after, changes, async () => {
      await this.options.agentConfigService.patch(agentId, "tools", {
        revision: configRevision(config),
        value: tools
      });
    }, { availableImplementations: ["tavily"] });
  }

  private prepareGroupMutation(context: SystemConfigTurnContext, input: SystemConfigInput) {
    const conversationId = input.conversationId!;
    if (!GROUP_CONVERSATION_ID.test(conversationId)) {
      return { result: failure("SYSTEM_CONFIG_GROUP_INVALID", "请使用设置查询返回的完整群聊 conversationId。") };
    }
    const runtime = this.options.getRuntime(context.agentId);
    const record = knownGroupRecords(runtime).find((candidate) => candidate.id === conversationId);
    if (!record) {
      return { result: failure("SYSTEM_CONFIG_GROUP_NOT_FOUND", "当前 Agent 中不存在该群聊。") };
    }
    if (record.scope !== "user_group" && input.orchestratorEnabled != null) {
      return { result: failure("SYSTEM_CONFIG_GROUP_ORCHESTRATOR_UNSUPPORTED", "该群聊类型不支持群聊编排器设置。") };
    }
    const before = {
      replyEnabled: record.replyEnabled !== false,
      orchestratorEnabled: record.orchestratorEnabled !== false
    };
    const after = {
      replyEnabled: input.enabled ?? before.replyEnabled,
      orchestratorEnabled: input.orchestratorEnabled ?? before.orchestratorEnabled
    };
    const changes = changedFields(before, after, `groups.${conversationId}`);
    if (!changes.length) return noOp("set_group_reply", before, after, { conversationId });
    return staged(input, before, after, changes, async () => {
      const latest = knownGroupRecords(runtime).find((candidate) => candidate.id === conversationId);
      if (!latest) throw mutationConflict("群聊在配置生效前已不存在。");
      if (
        (latest.replyEnabled !== false) !== before.replyEnabled ||
        (latest.orchestratorEnabled !== false) !== before.orchestratorEnabled
      ) {
        throw mutationConflict("群聊设置已更新，请重新查询后再修改。");
      }
      runtime.setConversationReplyEnabled({
        id: conversationId,
        ...(input.enabled == null ? {} : { replyEnabled: input.enabled }),
        ...(input.orchestratorEnabled == null ? {} : { orchestratorEnabled: input.orchestratorEnabled })
      });
    }, { conversationId });
  }
}

function knownGroupRecords(runtime: SystemConfigRuntime) {
  return runtime.getConversationRecords()
    .filter((record) => record.scope === "user_group" || record.scope === "bot_group")
    .filter((record) => GROUP_CONVERSATION_ID.test(record.id));
}

function safeGroup(record: ConversationRecord) {
  return {
    conversationId: record.id,
    accountId: record.accountId ?? "primary",
    groupId: record.groupId ?? null,
    title: record.groupName || record.title,
    scope: record.scope,
    replyEnabled: record.replyEnabled !== false,
    orchestratorEnabled: record.orchestratorEnabled !== false,
    lastAt: record.lastAt
  };
}

function compareConversationIds(left: ConversationRecord, right: ConversationRecord) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function configuredToolStates(config: AppConfig) {
  return Object.fromEntries(Object.entries(config.bot.tools.overrides ?? {}).map(([name, value]) => [
    name,
    value?.enabled ?? null
  ]));
}

async function safeToolCapabilities(runtime: SystemConfigRuntime) {
  try {
    const capabilities = await runtime.resolveToolCapabilities();
    return {
      workspaceBash: capabilities.workspaceBash === true,
      ...(capabilities.workspaceBashReason ? {
        workspaceBashReason: capabilities.workspaceBashReason
      } : {})
    };
  } catch {
    return { workspaceBash: false };
  }
}

function safeBashSettings(
  config: AppConfig,
  capabilities: { workspaceBash: boolean; workspaceBashReason?: WorkspaceBashUnavailableReason }
) {
  const configuredEnabled = config.bot.bash.enabled;
  const backend = "docker" as const;
  const available = capabilities.workspaceBash;
  const unavailableReason = available
    ? configuredEnabled ? null : "BASH_CONFIG_DISABLED"
    : capabilities.workspaceBashReason ?? "BASH_DOCKER_ISOLATION_UNAVAILABLE";
  const unavailableMessage = unavailableReason === "BASH_CONFIG_DISABLED"
    ? "Bash 未启用。"
    : unavailableReason === "BASH_AUDIT_UNAVAILABLE"
      ? "Bash 对抗审批 Agent 不可用，Bash 已安全关闭。"
        : unavailableReason === "BASH_WORKBENCH_UNAVAILABLE"
          ? "当前 Agent workbench 不可用，Bash 已安全关闭。"
          : unavailableReason === "BASH_NATIVE_ISOLATION_UNAVAILABLE"
            ? "宿主 Bash 已禁用。"
            : unavailableReason === "BASH_DOCKER_ISOLATION_UNAVAILABLE"
              ? "Docker 后端未通过强隔离检查；Bash 已安全关闭，不会使用 Docker socket 或宿主 Bash 回退。"
              : null;
  return {
    enabled: configuredEnabled,
    configuredEnabled,
    adminPrivateBackend: backend,
    configuredBackend: backend,
    routes: {
      administratorPrivateQq: "docker",
      administratorGroupQq: "docker",
      otherQqConversations: "docker"
    },
    auditModel: config.bot.bash.auditModel,
    strictMode: config.bot.bash.strictMode,
    available,
    effectiveEnabled: configuredEnabled && available,
    unavailableReason,
    unavailableMessage,
    ...(unavailableReason && unavailableReason !== "BASH_CONFIG_DISABLED"
      ? { unavailabilityKind: "runtime" }
      : {}),
    isolationRequired: "backend_specific",
    nativeHostExecutionAllowed: false,
    rawHostFallbackAllowed: false,
    dockerSocketAllowed: false
  };
}

function safeSystemSettings(config: AppConfig, fieldStates: Record<string, { secretConfigured?: boolean }>) {
  return {
    providers: {
      defaultProviderId: config.providers.defaultProviderId,
      items: config.providers.items.map((provider, index) => ({
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        enabled: provider.enabled,
        model: provider.model,
        imageModel: provider.imageModel,
        reasoningEffort: provider.reasoningEffort ?? null,
        credentialConfigured: (
          fieldStates[`providers.items.${provider.id}.apiKeyEnv`] ??
          fieldStates[`providers.items.${index}.apiKeyEnv`]
        )?.secretConfigured === true
      }))
    },
    broadcastStorm: {
      enabled: config.broadcastStorm.enabled,
      windowMinutes: config.broadcastStorm.windowMinutes,
      replyThreshold: config.broadcastStorm.replyThreshold,
      cooldownMinutes: config.broadcastStorm.cooldownMinutes
    },
    normalReply: { maxRetries: config.normalReply.maxRetries }
  };
}

function safeOnebotStatus(value: unknown) {
  const status = asRecord(value);
  return {
    connected: status.connected === true,
    connections: safeNumber(status.connections),
    selfIds: stringList(status.selfIds, 32),
    accounts: Array.isArray(status.accounts)
      ? status.accounts.slice(0, 32).map((item) => {
          const account = asRecord(item);
          return {
            accountId: safeString(account.accountId),
            selfId: safeString(account.selfId),
            connectedAt: safeString(account.connectedAt)
          };
        })
      : [],
    connectedAt: safeNullableString(status.connectedAt),
    lastEventAt: safeNullableString(status.lastEventAt),
    lastMessageEventAt: safeNullableString(status.lastMessageEventAt)
  };
}

function safePersonaStatus(value: unknown) {
  const status = asRecord(value);
  return {
    id: safeString(status.id),
    name: safeString(status.name),
    memoryItems: safeNumber(status.memoryItems)
  };
}

function safeProviderStatus(value: unknown) {
  const status = asRecord(value);
  return {
    defaultProviderId: safeString(status.defaultProviderId),
    model: safeString(status.model),
    imageModel: safeString(status.imageModel),
    apiKeyConfigured: status.apiKeyConfigured === true
  };
}

function safeProbe(value: unknown) {
  const probe = asRecord(value);
  const summary = asRecord(probe.summary);
  return {
    summary: {
      liveness: safeString(summary.liveness),
      readiness: safeString(summary.readiness),
      capability: safeString(summary.capability)
    },
    checks: Array.isArray(probe.checks)
      ? probe.checks.slice(0, 100).map((item) => {
          const check = asRecord(item);
          return {
            id: safeString(check.id),
            kind: safeString(check.kind),
            status: safeString(check.status),
            code: safeNullableString(check.code)
          };
        })
      : []
  };
}

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string
) {
  return Object.keys(after)
    .filter((key) => before[key] !== after[key])
    .map((key) => `${prefix}.${key}`);
}

function isMutation(input: SystemConfigInput) {
  return input.operation !== "get_settings" && input.operation !== "get_status" &&
    input.operation !== "list_groups";
}

function staged(
  input: SystemConfigInput,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changes: string[],
  commit: () => Promise<void>,
  details: Record<string, unknown> = {},
  closesCurrentPrivateReplyGate = false
) {
  const operation = input.operation as SystemConfigMutationDescriptor["action"];
  return {
    pending: {
      commit,
      descriptor: {
        action: operation,
        normalizedInput: structuredClone(input),
        closesCurrentPrivateReplyGate
      }
    },
    result: {
      ok: true,
      operation,
      staged: true,
      persisted: false,
      noOp: false,
      effectiveFrom: "next_turn",
      before,
      after,
      changes,
      ...details
    }
  };
}

function noOp(
  operation: SystemConfigInput["operation"],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  details: Record<string, unknown> = {}
) {
  return {
    result: {
      ok: true,
      operation,
      staged: false,
      persisted: true,
      noOp: true,
      effectiveFrom: "current_turn",
      before,
      after,
      changes: [],
      ...details
    }
  };
}

function failure(code: string, error: string) {
  return { ok: false, code, error };
}

function mutationConflict(message: string) {
  return Object.assign(new Error(message), { code: "SYSTEM_CONFIG_REVISION_CONFLICT" });
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function safeString(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function safeNullableString(value: unknown) {
  const normalized = safeString(value);
  return normalized || null;
}

function safeNumber(value: unknown) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function stringList(value: unknown, limit: number) {
  return Array.isArray(value) ? value.slice(0, limit).map(safeString).filter(Boolean) : [];
}
