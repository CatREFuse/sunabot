const STORAGE_KEY = "sunabot.current-agent";
let selectedAgentId = readStoredAgentId();

export function activeAgentId() {
  return selectedAgentId || "plana";
}

export function setActiveAgentId(agentId: string) {
  selectedAgentId = agentId.trim() || "plana";
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, selectedAgentId);
}

export function agentScopedPath(path: string, agentId = activeAgentId()) {
  const url = new URL(path, window.location.origin);
  if (!url.searchParams.has("agentId")) url.searchParams.set("agentId", agentId);
  return `${url.pathname}${url.search}${url.hash}`;
}

function readStoredAgentId() {
  if (typeof window === "undefined") return "plana";
  return window.localStorage.getItem(STORAGE_KEY)?.trim() || "plana";
}
