import { computed, readonly, shallowRef } from "vue";
import type { AgentAccount, AgentAvatarInput, AgentSummary } from "../types";
import type { AgentConfigImportPayload } from "./useAgentConfigImport";
import { apiRequest } from "./useAdminApi";
import { activeAgentId, setActiveAgentId } from "./agentScope";

const agents = shallowRef<AgentSummary[]>([]);
const currentAgentId = shallowRef(activeAgentId());
const loading = shallowRef(false);
const error = shallowRef("");
let loadPromise: Promise<AgentSummary[]> | undefined;

const currentAgent = computed(() => (
  agents.value.find((agent) => agent.id === currentAgentId.value)
  ?? agents.value.find((agent) => agent.enabled)
  ?? agents.value[0]
));

export function useAgents() {
  async function load(options: { force?: boolean } = {}) {
    if (loadPromise && !options.force) return loadPromise;
    loading.value = true;
    error.value = "";
    loadPromise = apiRequest<{ agents: AgentSummary[] }>("/api/agents")
      .then((response) => {
        agents.value = response.agents;
        const selected = currentAgent.value;
        if (selected) select(selected.id);
        return response.agents;
      })
      .catch((cause) => {
        error.value = message(cause, "Agent 列表读取失败");
        throw cause;
      })
      .finally(() => {
        loading.value = false;
        loadPromise = undefined;
      });
    return loadPromise;
  }

  function select(agentId: string) {
    const agent = agents.value.find((item) => item.id === agentId);
    if (!agent) return;
    currentAgentId.value = agent.id;
    setActiveAgentId(agent.id);
  }

  async function create(input: {
    id: string;
    name: string;
    avatar?: { fileName: string; dataBase64: string };
    import?: AgentConfigImportPayload;
  }) {
    const created = await apiRequest<AgentSummary>("/api/agents", {
      method: "POST",
      body: JSON.stringify(input)
    });
    await load({ force: true });
    select(created.id);
    return created;
  }

  async function update(agentId: string, input: { name?: string; enabled?: boolean }) {
    await apiRequest<AgentSummary>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
    await load({ force: true });
  }

  async function remove(agentId: string, confirmation: string) {
    await apiRequest(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation })
    });
    await load({ force: true });
  }

  async function updateAvatar(agentId: string, avatar: AgentAvatarInput) {
    const updated = await apiRequest<AgentSummary>(`/api/agents/${encodeURIComponent(agentId)}/avatar`, {
      method: "PUT",
      body: JSON.stringify({ avatar })
    });
    const current = agents.value.find((agent) => agent.id === updated.id);
    const merged = current ? { ...current, ...updated } : updated;
    agents.value = agents.value.map((agent) => agent.id === updated.id ? merged : agent);
    return merged;
  }

  async function createAccount(agentId: string, label: string) {
    const account = await apiRequest<AgentAccount>(`/api/agents/${encodeURIComponent(agentId)}/accounts`, {
      method: "POST",
      body: JSON.stringify({ label })
    });
    await load({ force: true });
    return account;
  }

  async function startAccountRuntime(agentId: string, accountId: string) {
    const account = await apiRequest<AgentAccount>(
      `/api/agents/${encodeURIComponent(agentId)}/accounts/${encodeURIComponent(accountId)}/runtime/start`,
      { method: "POST" }
    );
    await load({ force: true });
    return account;
  }

  async function removeAccount(agentId: string, accountId: string) {
    await apiRequest(`/api/agents/${encodeURIComponent(agentId)}/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE"
    });
    await load({ force: true });
  }

  return {
    agents: readonly(agents),
    currentAgentId: readonly(currentAgentId),
    currentAgent,
    loading: readonly(loading),
    error: readonly(error),
    load,
    select,
    create,
    update,
    remove,
    updateAvatar,
    createAccount,
    startAccountRuntime,
    removeAccount
  };
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
