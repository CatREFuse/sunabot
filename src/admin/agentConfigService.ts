import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import type { AgentRuntimeManager } from "../../services/agents/agentRuntimeManager.js";
import type { AppConfig } from "../types.js";
import type { ConfigService } from "./configService.js";
import {
  configRevision,
  mergeConfigSection,
  parseConfigSection,
  validateConfigSectionValue,
  type ConfigSection
} from "./configService.js";
import { badRequest, conflict } from "./errors.js";

const GLOBAL_SECTIONS = new Set<ConfigSection>(["server", "providers", "broadcastStorm", "normalReply"]);

export class AgentConfigService {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly runtimes: AgentRuntimeManager,
    private readonly globalConfigService: Pick<ConfigService, "readEnvelope" | "patch" | "patchGroupReply">
  ) {}

  async readEnvelope(agentId: string) {
    return this.globalConfigService.readEnvelope(await this.registry.config(agentId));
  }

  async patch(agentId: string, sectionInput: string, body: unknown) {
    const section = parseConfigSection(sectionInput);
    if (GLOBAL_SECTIONS.has(section)) {
      const request = parsePatch(body);
      assertRevision(await this.registry.config(agentId), request.revision);
      const global = await this.globalConfigService.readEnvelope();
      await this.globalConfigService.patch(section, { revision: global.revision, value: request.value });
      return this.readEnvelope(agentId);
    }
    const request = parsePatch(body);
    const current = await this.registry.config(agentId);
    assertRevision(current, request.revision);
    assertImmutableAgentWorkspace(section, request.value, current);
    const value = validateConfigSectionValue(section, request.value, current);
    const candidate = preserveSharedAndIdentity(current, mergeConfigSection(current, section, value));
    await this.apply(agentId, current, candidate);
    return { ok: true, ...(await this.globalConfigService.readEnvelope(candidate)), applyMode: "hot", restartRequiredFields: [] };
  }

  async patchGroupReply(agentId: string, body: unknown) {
    const request = parsePatch(body);
    const current = await this.registry.config(agentId);
    assertRevision(current, request.revision);
    const value = object(request.value);
    if (typeof value.enabled !== "boolean" || !value.orchestrator) {
      badRequest("CONFIG_INVALID", "群聊回复设置无效。", "groupReply");
    }
    let candidate = mergeConfigSection(
      current,
      "orchestrator",
      validateConfigSectionValue("orchestrator", value.orchestrator, current)
    );
    candidate.onebot.autoReplyUserGroup = value.enabled;
    candidate = preserveSharedAndIdentity(current, candidate);
    await this.apply(agentId, current, candidate);
    return { ok: true, ...(await this.globalConfigService.readEnvelope(candidate)), applyMode: "hot", restartRequiredFields: [] };
  }

  private async apply(agentId: string, current: AppConfig, candidate: AppConfig) {
    const runtime = this.runtimes.require(agentId);
    const snapshot = await runtime.prepareReload(candidate);
    const { previous } = await this.registry.saveAgentConfig(agentId, candidate);
    try {
      runtime.commitReload(snapshot);
    } catch (error) {
      await this.registry.restoreManifest(agentId, previous);
      await runtime.reload(current);
      throw error;
    }
  }
}

function assertImmutableAgentWorkspace(section: ConfigSection, value: unknown, current: AppConfig) {
  if (section !== "persona" || !value || typeof value !== "object" || Array.isArray(value)) return;
  const workspace = (value as Record<string, unknown>).agentWorkspace;
  if (workspace !== current.persona.agentWorkspace) {
    badRequest("CONFIG_INVALID", "Agent workspace 不可修改。", "persona.agentWorkspace");
  }
}

function preserveSharedAndIdentity(current: AppConfig, candidate: AppConfig) {
  candidate.server = structuredClone(current.server);
  candidate.providers = structuredClone(current.providers);
  candidate.normalReply = structuredClone(current.normalReply);
  candidate.persona.defaultAgentId = current.persona.defaultAgentId;
  candidate.persona.name = current.persona.name;
  candidate.persona.agentWorkspace = current.persona.agentWorkspace;
  candidate.persona.systemPromptWorkspace = current.persona.systemPromptWorkspace;
  candidate.persona.systemPromptOverride = current.persona.systemPromptOverride;
  candidate.persona.avatarPath = current.persona.avatarPath;
  candidate.onebot.reverseWsPath = current.onebot.reverseWsPath;
  candidate.onebot.accessTokenEnv = current.onebot.accessTokenEnv;
  return candidate;
}

function parsePatch(input: unknown) {
  const body = object(input);
  const extra = Object.keys(body).find((key) => key !== "revision" && key !== "value");
  if (extra || typeof body.revision !== "string" || !body.revision.trim()) {
    badRequest("CONFIG_INVALID", "配置请求无效。", extra ?? "revision");
  }
  return { revision: body.revision as string, value: body.value };
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) badRequest("CONFIG_INVALID", "配置请求无效。");
  return value as Record<string, unknown>;
}

function assertRevision(config: AppConfig, revision: string) {
  const current = configRevision(config);
  if (current !== revision) conflict("CONFIG_REVISION_CONFLICT", "配置已更新，请加载最新内容。", current);
}
