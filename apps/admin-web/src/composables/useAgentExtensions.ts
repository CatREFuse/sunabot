import { readonly, shallowRef } from "vue";
import type {
  AgentExtensionOverview,
  AgentMcpServer,
  AgentSkillRecord,
  McpApprovalTicket,
  McpCatalogSnapshot,
  McpInstallPreview,
  McpRuntimeStatus,
  SkillCopyPreview,
  SkillCopyResult
} from "../types/agentExtensions";
import { apiRequest } from "./useAdminApi";

const MAX_SKILL_ARCHIVE_BYTES = 16 * 1024 * 1024;

export function useAgentExtensions() {
  const overview = shallowRef<AgentExtensionOverview | null>(null);
  const runtime = shallowRef<McpRuntimeStatus>({ servers: [] });
  const approvals = shallowRef<McpApprovalTicket[]>([]);
  const loading = shallowRef(false);
  const busy = shallowRef(false);
  const error = shallowRef("");
  const message = shallowRef("");
  let activeAgentId = "";
  let loadGeneration = 0;
  let pendingOperations = 0;

  async function load(agentId: string) {
    const generation = ++loadGeneration;
    if (activeAgentId !== agentId) {
      activeAgentId = agentId;
      overview.value = null;
      runtime.value = { servers: [] };
      approvals.value = [];
      error.value = "";
      message.value = "";
    }
    loading.value = true;
    error.value = "";
    try {
      const nextOverview = await apiRequest<AgentExtensionOverview>(
        `/api/agent-extensions?agentId=${encodeURIComponent(agentId)}`
      );
      if (!isCurrentLoad(agentId, generation)) return false;
      const [nextRuntime, nextApprovals] = await Promise.all([
        apiRequest<McpRuntimeStatus>(`/api/agent-extensions/mcp/runtime/status?agentId=${encodeURIComponent(agentId)}`)
          .then((value) => ({ value, error: "" }))
          .catch(() => ({ value: { servers: [] } as McpRuntimeStatus, error: "MCP 运行状态读取失败" })),
        apiRequest<{ approvals: McpApprovalTicket[] }>(
          `/api/agent-extensions/mcp/runtime/approvals?agentId=${encodeURIComponent(agentId)}`
        )
          .then((value) => ({ value, error: "" }))
          .catch(() => ({ value: { approvals: [] as McpApprovalTicket[] }, error: "MCP 批准队列读取失败" }))
      ]);
      if (!isCurrentLoad(agentId, generation)) return false;
      if (nextOverview.agentId !== agentId) throw new Error("扩展响应与当前 Agent 不匹配");
      overview.value = nextOverview;
      runtime.value = nextRuntime.value;
      approvals.value = nextApprovals.value.approvals;
      error.value = [nextRuntime.error, nextApprovals.error].filter(Boolean).join(" · ");
      return true;
    } catch (cause) {
      if (!isCurrentLoad(agentId, generation)) return false;
      error.value = errorMessage(cause, "扩展读取失败");
      throw cause;
    } finally {
      if (isCurrentLoad(agentId, generation)) loading.value = false;
    }
  }

  async function mutate<T>(agentId: string, success: string | ((result: T) => string), operation: () => Promise<T>) {
    claimInitialAgent(agentId);
    beginOperation();
    if (isActiveAgent(agentId)) {
      error.value = "";
      message.value = "";
    }
    try {
      const result = await operation();
      if (!isActiveAgent(agentId)) return result;
      message.value = typeof success === "function" ? success(result) : success;
      try {
        await load(agentId);
      } catch {
        if (isActiveAgent(agentId)) error.value = "操作已完成，扩展刷新失败，请手动刷新。";
      }
      return result;
    } catch (cause) {
      if (isActiveAgent(agentId)) error.value = errorMessage(cause, "操作失败");
      throw cause;
    } finally {
      endOperation();
    }
  }

  async function installSkill(agentId: string, archive: File, replace: boolean) {
    if (!archive.size || archive.size > MAX_SKILL_ARCHIVE_BYTES) {
      throw new Error("Skill ZIP 需小于 16 MiB。");
    }
    const archiveBase64 = encodeBase64(new Uint8Array(await archive.arrayBuffer()));
    return mutate(agentId, "Skill 已安装", () => apiRequest<AgentSkillRecord>("/api/agent-extensions/skills", {
      method: "POST",
      body: JSON.stringify({ agentId, archiveBase64, replace })
    }));
  }

  async function reviewSkill(agentId: string, skillId: string) {
    return mutate(agentId, "Skill 已通过审核", () => apiRequest<AgentSkillRecord>(
      `/api/agent-extensions/skills/${encodeURIComponent(skillId)}/review`,
      { method: "POST", body: JSON.stringify({ agentId, approve: true }) }
    ));
  }

  async function setSkillEnabled(agentId: string, skillId: string, enabled: boolean) {
    return mutate(agentId, enabled ? "Skill 已启用" : "Skill 已停用", () => apiRequest<AgentSkillRecord>(
      `/api/agent-extensions/skills/${encodeURIComponent(skillId)}`,
      { method: "PATCH", body: JSON.stringify({ agentId, enabled }) }
    ));
  }

  async function removeSkill(agentId: string, skillId: string) {
    return mutate(agentId, "Skill 已卸载", () => apiRequest<AgentSkillRecord>(
      `/api/agent-extensions/skills/${encodeURIComponent(skillId)}?agentId=${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    ));
  }

  async function previewSkillCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds?: string[];
  }) {
    claimInitialAgent(input.sourceAgentId);
    if (isActiveAgent(input.sourceAgentId)) error.value = "";
    try {
      return await apiRequest<SkillCopyPreview>("/api/agent-extensions/skills/copy/preview", {
        method: "POST",
        body: JSON.stringify(input)
      });
    } catch (cause) {
      if (isActiveAgent(input.sourceAgentId)) error.value = errorMessage(cause, "迁移预览失败");
      throw cause;
    }
  }

  async function applySkillCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds?: string[];
    previewRevision: string;
    conflictStrategy: "skip" | "replace" | "rename";
    renameTo?: string;
  }) {
    return mutate(input.sourceAgentId, (result) => result.skipped ? "Skill 已跳过" : "Skill 已迁移", () => apiRequest<SkillCopyResult>(
      "/api/agent-extensions/skills/copy",
      { method: "POST", body: JSON.stringify(input) }
    ));
  }

  async function previewMcpServer(agentId: string, server: AgentMcpServer) {
    claimInitialAgent(agentId);
    if (isActiveAgent(agentId)) error.value = "";
    try {
      return await apiRequest<McpInstallPreview>("/api/agent-extensions/mcp/servers/preview", {
        method: "POST",
        body: JSON.stringify({ agentId, server })
      });
    } catch (cause) {
      if (isActiveAgent(agentId)) error.value = errorMessage(cause, "MCP 预览失败");
      throw cause;
    }
  }

  async function putMcpServer(agentId: string, preview: McpInstallPreview, replace: boolean) {
    return mutate(agentId, "MCP 服务已保存", () => apiRequest<AgentMcpServer>(
      "/api/agent-extensions/mcp/servers",
      {
        method: "PUT",
        body: JSON.stringify({
          agentId,
          server: preview.server,
          replace,
          previewRevision: preview.previewRevision,
          approveCommand: preview.commandApproval !== null
        })
      }
    ));
  }

  async function setMcpServerEnabled(agentId: string, serverId: string, enabled: boolean) {
    return mutate(agentId, enabled ? "MCP 服务已启用" : "MCP 服务已停用", () => apiRequest<AgentMcpServer>(
      `/api/agent-extensions/mcp/servers/${encodeURIComponent(serverId)}`,
      { method: "PATCH", body: JSON.stringify({ agentId, enabled }) }
    ));
  }

  async function removeMcpServer(agentId: string, serverId: string) {
    return mutate(agentId, "MCP 服务已删除", () => apiRequest<AgentMcpServer>(
      `/api/agent-extensions/mcp/servers/${encodeURIComponent(serverId)}?agentId=${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    ));
  }

  async function loadMcpCatalog(agentId: string, serverId: string) {
    return apiRequest<McpCatalogSnapshot>(
      `/api/agent-extensions/mcp/runtime/catalog?agentId=${encodeURIComponent(agentId)}&serverId=${encodeURIComponent(serverId)}`
    );
  }

  async function approveMcpTool(agentId: string, ticketId: string) {
    return mutate(agentId, "MCP 请求已批准", () => apiRequest<{ ok: true }>(
      "/api/agent-extensions/mcp/runtime/approvals/approve",
      { method: "POST", body: JSON.stringify({ agentId, ticketId }) }
    ));
  }

  async function beginOAuth(agentId: string, serverId: string, input: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    scopes: string[];
  }) {
    claimInitialAgent(agentId);
    beginOperation();
    if (isActiveAgent(agentId)) error.value = "";
    try {
      return await apiRequest<{ authorizationUrl: string; authorizationOrigin: string; expiresAt: string }>(
        "/api/agent-extensions/mcp/oauth/begin",
        { method: "POST", body: JSON.stringify({ agentId, serverId, ...input }) }
      );
    } catch (cause) {
      if (isActiveAgent(agentId)) error.value = errorMessage(cause, "OAuth 授权启动失败");
      throw cause;
    } finally {
      endOperation();
    }
  }

  async function refreshOAuth(agentId: string, serverId: string) {
    return mutate(agentId, "OAuth 凭据已刷新", () => apiRequest<{ ok: true; expiresAt?: string }>(
      "/api/agent-extensions/mcp/oauth/refresh",
      { method: "POST", body: JSON.stringify({ agentId, serverId }) }
    ));
  }

  async function revokeOAuth(agentId: string, serverId: string) {
    return mutate(agentId, "OAuth 凭据已撤销", () => apiRequest<{ ok: true }>(
      "/api/agent-extensions/mcp/oauth/revoke",
      { method: "POST", body: JSON.stringify({ agentId, serverId }) }
    ));
  }

  function clearFeedback() {
    error.value = "";
    message.value = "";
  }

  function isCurrentLoad(agentId: string, generation: number) {
    return activeAgentId === agentId && loadGeneration === generation;
  }

  function isActiveAgent(agentId: string) {
    return activeAgentId === agentId;
  }

  function claimInitialAgent(agentId: string) {
    if (!activeAgentId) activeAgentId = agentId;
  }

  function beginOperation() {
    pendingOperations += 1;
    busy.value = true;
  }

  function endOperation() {
    pendingOperations = Math.max(0, pendingOperations - 1);
    busy.value = pendingOperations > 0;
  }

  return {
    overview: readonly(overview),
    runtime: readonly(runtime),
    approvals: readonly(approvals),
    loading: readonly(loading),
    busy: readonly(busy),
    error: readonly(error),
    message: readonly(message),
    load,
    installSkill,
    reviewSkill,
    setSkillEnabled,
    removeSkill,
    previewSkillCopy,
    applySkillCopy,
    previewMcpServer,
    putMcpServer,
    setMcpServerEnabled,
    removeMcpServer,
    loadMcpCatalog,
    approveMcpTool,
    beginOAuth,
    refreshOAuth,
    revokeOAuth,
    clearFeedback
  };
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
