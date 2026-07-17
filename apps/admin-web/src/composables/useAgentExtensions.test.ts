import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMcpServer } from "../types/agentExtensions";
import { useAgentExtensions } from "./useAgentExtensions";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

describe("useAgentExtensions", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("loads the Agent overview, runtime state and approval queue together", async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (path === "/api/agent-extensions?agentId=agent-a") {
        return { schemaVersion: 1, agentId: "agent-a", skills: [], mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } } };
      }
      if (path.includes("/runtime/status")) return { servers: [{ serverId: "server-a", status: "ready", toolCatalogStatus: "ready" }] };
      if (path.includes("/runtime/approvals")) return { approvals: [{ id: "ticket-a" }] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();

    await state.load("agent-a");

    expect(state.overview.value?.agentId).toBe("agent-a");
    expect(state.runtime.value.servers[0]?.serverId).toBe("server-a");
    expect(state.approvals.value[0]?.id).toBe("ticket-a");
  });

  it("keeps only the newest Agent load when responses resolve out of order", async () => {
    const delayedAgentA = deferred<ReturnType<typeof emptyOverview>>();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === "/api/agent-extensions?agentId=agent-a") return delayedAgentA.promise;
      if (path === "/api/agent-extensions?agentId=agent-b") return emptyOverview("agent-b");
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();

    const loadAgentA = state.load("agent-a");
    const loadAgentB = state.load("agent-b");
    await loadAgentB;
    delayedAgentA.resolve(emptyOverview("agent-a"));
    await loadAgentA;

    expect(state.overview.value?.agentId).toBe("agent-b");
    expect(state.loading.value).toBe(false);
  });

  it("removes the previous Agent snapshot immediately when the next Agent load fails", async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (path === "/api/agent-extensions?agentId=agent-a") return emptyOverview("agent-a");
      if (path === "/api/agent-extensions?agentId=agent-b") throw new Error("agent-b unavailable");
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();
    await state.load("agent-a");

    const loadAgentB = state.load("agent-b");
    expect(state.overview.value).toBeNull();
    expect(state.runtime.value.servers).toEqual([]);
    expect(state.approvals.value).toEqual([]);
    await expect(loadAgentB).rejects.toThrow("agent-b unavailable");

    expect(state.overview.value).toBeNull();
    expect(state.error.value).toBe("agent-b unavailable");
  });

  it("does not publish or refresh an old Agent mutation after the active Agent changes", async () => {
    const delayedRemoval = deferred<{ id: string }>();
    let agentAOverviewLoads = 0;
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/agent-extensions?agentId=agent-a") {
        agentAOverviewLoads += 1;
        return emptyOverview("agent-a");
      }
      if (path === "/api/agent-extensions?agentId=agent-b") return emptyOverview("agent-b");
      if (path === "/api/agent-extensions/skills/skill-a?agentId=agent-a" && init?.method === "DELETE") {
        return delayedRemoval.promise;
      }
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();
    await state.load("agent-a");

    const removal = state.removeSkill("agent-a", "skill-a");
    await state.load("agent-b");
    delayedRemoval.resolve({ id: "skill-a" });
    await removal;

    expect(state.overview.value?.agentId).toBe("agent-b");
    expect(state.message.value).toBe("");
    expect(agentAOverviewLoads).toBe(1);
  });

  it("encodes a bounded Skill ZIP and refreshes the same Agent", async () => {
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/agent-extensions/skills") {
        const body = JSON.parse(String(init?.body)) as { archiveBase64: string; agentId: string; replace: boolean };
        expect(body).toEqual({ archiveBase64: "UEsDBA==", agentId: "agent-a", replace: false });
        return { id: "skill-a" };
      }
      if (path === "/api/agent-extensions?agentId=agent-a") {
        return { schemaVersion: 1, agentId: "agent-a", skills: [], mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } } };
      }
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();

    await state.installSkill("agent-a", new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "skill.zip"), false);

    expect(state.message.value).toBe("Skill 已安装");
  });

  it("uses the preview revision and explicit command approval when saving stdio MCP", async () => {
    const server: AgentMcpServer = {
      id: "server-a",
      name: "Server A",
      description: "Local server",
      enabled: false,
      required: false,
      enabledTools: [],
      disabledTools: [],
      approvalMode: "always",
      transport: "stdio",
      command: "/usr/bin/server-a",
      args: ["--stdio"],
      envKeys: []
    };
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/mcp/servers/preview")) return {
        schemaVersion: 1,
        previewRevision: "a".repeat(64),
        server,
        commandApproval: { required: true, command: server.command, args: server.args, digestSha256: "b".repeat(64) }
      };
      if (path === "/api/agent-extensions/mcp/servers") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          agentId: "agent-a",
          server,
          replace: false,
          previewRevision: "a".repeat(64),
          approveCommand: true
        });
        return server;
      }
      if (path === "/api/agent-extensions?agentId=agent-a") {
        return { schemaVersion: 1, agentId: "agent-a", skills: [], mcp: { servers: [server], secrets: { configuredKeys: [], missingKeys: [] } } };
      }
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();
    const preview = await state.previewMcpServer("agent-a", server);

    await state.putMcpServer("agent-a", preview, false);

    expect(state.overview.value?.mcp.servers[0]?.id).toBe("server-a");
  });

  it("keeps a completed mutation successful when the following overview refresh fails", async () => {
    apiRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/agent-extensions/skills/skill-a?agentId=agent-a" && init?.method === "DELETE") {
        return { id: "skill-a" };
      }
      if (path === "/api/agent-extensions?agentId=agent-a") throw new Error("overview unavailable");
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();

    await expect(state.removeSkill("agent-a", "skill-a")).resolves.toEqual({ id: "skill-a" });

    expect(state.message.value).toBe("Skill 已卸载");
    expect(state.error.value).toBe("操作已完成，扩展刷新失败，请手动刷新。");
    expect(apiRequest).toHaveBeenCalledTimes(4);
  });

  it("reports a copy skip without claiming that the Skill was migrated", async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (path === "/api/agent-extensions/skills/copy") {
        return { schemaVersion: 1, sourceAgentId: "agent-a", targetAgentId: "agent-b", skill: null, skipped: true, mcpServers: [] };
      }
      if (path === "/api/agent-extensions?agentId=agent-a") {
        return { schemaVersion: 1, agentId: "agent-a", skills: [], mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } } };
      }
      if (path.includes("/runtime/status")) return { servers: [] };
      if (path.includes("/runtime/approvals")) return { approvals: [] };
      throw new Error(`Unexpected ${path}`);
    });
    const state = useAgentExtensions();

    const result = await state.applySkillCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: "skill-a",
      previewRevision: "a".repeat(64),
      conflictStrategy: "skip"
    });

    expect(result.skipped).toBe(true);
    expect(state.message.value).toBe("Skill 已跳过");
  });

  it("keeps the overview visible while reporting unavailable runtime side channels", async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (path === "/api/agent-extensions?agentId=agent-a") {
        return { schemaVersion: 1, agentId: "agent-a", skills: [], mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } } };
      }
      throw new Error("side channel unavailable");
    });
    const state = useAgentExtensions();

    await state.load("agent-a");

    expect(state.overview.value?.agentId).toBe("agent-a");
    expect(state.error.value).toBe("MCP 运行状态读取失败 · MCP 批准队列读取失败");
  });
});

function emptyOverview(agentId: string) {
  return {
    schemaVersion: 1 as const,
    agentId,
    skills: [],
    mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
