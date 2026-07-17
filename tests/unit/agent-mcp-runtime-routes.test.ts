// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentMcpRuntimeRoutes } from "../../apps/api/plugins/agentMcpRuntimeRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Agent MCP runtime API", () => {
  it("guards catalog access and exposes a bounded server snapshot", async () => {
    const service = serviceMock();
    service.catalog.mockResolvedValue({ tools: [], resources: [], resourceTemplates: [], prompts: [] });
    const guard = vi.fn(async (request: { headers: Record<string, unknown> }) => {
      if (request.headers["x-test-admin"] !== "yes") {
        throw Object.assign(new Error("unauthorized"), { statusCode: 401, code: "UNAUTHORIZED" });
      }
    });
    const app = Fastify();
    apps.push(app);
    registerAgentMcpRuntimeRoutes(app, { service: service as never, adminGuard: guard as never });
    expect((await app.inject({
      method: "GET",
      url: "/api/agent-extensions/mcp/runtime/catalog?agentId=agent-a&serverId=server-a"
    })).statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/api/agent-extensions/mcp/runtime/catalog?agentId=agent-a&serverId=server-a",
      headers: { "x-test-admin": "yes" }
    });
    expect(response.statusCode).toBe(200);
    expect(service.catalog).toHaveBeenCalledWith({ agentId: "agent-a", serverId: "server-a" });
  });

  it("routes explicit tools, resources and prompts with AbortSignals and rejects secret-shaped extras", async () => {
    const service = serviceMock();
    for (const operation of ["callTool", "readResource", "subscribeResource", "unsubscribeResource", "getPrompt"] as const) {
      service[operation].mockResolvedValue({ ok: true });
    }
    const app = Fastify();
    apps.push(app);
    registerAgentMcpRuntimeRoutes(app, {
      service: service as never,
      adminGuard: vi.fn(async () => undefined) as never
    });
    const requests = [
      {
        url: "/api/agent-extensions/mcp/runtime/tools/call",
        payload: { agentId: "agent-a", serverId: "server-a", toolName: "search", arguments: { query: "test" } },
        method: "callTool"
      },
      ...(["read", "subscribe", "unsubscribe"] as const).map((operation) => ({
        url: `/api/agent-extensions/mcp/runtime/resources/${operation}`,
        payload: { agentId: "agent-a", serverId: "server-a", uri: "file:///workbench/readme.md" },
        method: operation === "read" ? "readResource" : `${operation}Resource`
      })),
      {
        url: "/api/agent-extensions/mcp/runtime/prompts/get",
        payload: { agentId: "agent-a", serverId: "server-a", name: "review", arguments: { focus: "security" } },
        method: "getPrompt"
      }
    ];
    for (const request of requests) {
      const response = await app.inject({ method: "POST", url: request.url, payload: request.payload });
      expect(response.statusCode).toBe(200);
      expect(service[request.method as keyof typeof service]).toHaveBeenCalledWith({
        ...request.payload,
        signal: expect.any(AbortSignal)
      });
    }
    const rejected = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/mcp/runtime/tools/call",
      payload: {
        agentId: "agent-a",
        serverId: "server-a",
        toolName: "search",
        arguments: {},
        token: "must-not-leak"
      }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain("must-not-leak");
    expect(service.callTool).toHaveBeenCalledOnce();
  });

  it("lists and approves one-time chat tickets behind the admin guard", async () => {
    const service = serviceMock();
    const ticket = {
      id: `mcpa_${"a".repeat(24)}`,
      agentId: "agent-a",
      accountId: "primary",
      transport: "onebot",
      conversationId: "private:1",
      userId: 1,
      serverId: "server-a",
      toolName: "search",
      snapshotDigest: "a".repeat(64),
      catalogGeneration: 1,
      argumentsDigest: "b".repeat(64),
      arguments: { query: "status", token: "[REDACTED]" },
      status: "pending",
      createdAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-07-17T00:10:00.000Z"
    };
    service.pendingApprovals.mockResolvedValue({ approvals: [ticket] });
    service.approveTool.mockResolvedValue({ ok: true });
    const app = Fastify();
    apps.push(app);
    registerAgentMcpRuntimeRoutes(app, {
      service: service as never,
      adminGuard: vi.fn(async () => undefined) as never
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/agent-extensions/mcp/runtime/approvals?agentId=agent-a"
    })).json()).toEqual({ approvals: [ticket] });
    const approved = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/mcp/runtime/approvals/approve",
      payload: { agentId: "agent-a", ticketId: `mcpa_${"a".repeat(24)}` }
    });
    expect(approved.statusCode).toBe(200);
    expect(service.approveTool).toHaveBeenCalledWith({
      agentId: "agent-a", ticketId: `mcpa_${"a".repeat(24)}`
    });
  });
});

function serviceMock() {
  return {
    status: vi.fn(),
    catalog: vi.fn(),
    pendingApprovals: vi.fn(),
    approveTool: vi.fn(),
    callTool: vi.fn(),
    readResource: vi.fn(),
    subscribeResource: vi.fn(),
    unsubscribeResource: vi.fn(),
    getPrompt: vi.fn()
  };
}
