// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentExtensionRoutes } from "../../apps/api/plugins/agentExtensionRoutes.js";
import { AgentExtensionService } from "../../services/extensions/public.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Agent extension API plugin", () => {
  it("uses the injected admin guard and returns a closed path/secret-free overview", async () => {
    const service = serviceMock();
    service.overview.mockResolvedValue({
      schemaVersion: 1,
      agentId: "agent-a",
      skills: [],
      mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } },
      hostPath: "/private/workspace",
      secretValue: "must-not-leak"
    });
    const guard = vi.fn(async (request: { headers: Record<string, unknown> }) => {
      if (request.headers["x-test-admin"] !== "yes") {
        throw Object.assign(new Error("unauthorized"), { statusCode: 401, code: "UNAUTHORIZED" });
      }
    });
    const app = Fastify();
    apps.push(app);
    registerAgentExtensionRoutes(app, { service: service as never, adminGuard: guard as never });

    const denied = await app.inject({ method: "GET", url: "/api/agent-extensions?agentId=agent-a" });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/api/agent-extensions?agentId=agent-a",
      headers: { "x-test-admin": "yes" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      agentId: "agent-a",
      skills: [],
      mcp: { servers: [], secrets: { configuredKeys: [], missingKeys: [] } }
    });
    expect(response.body).not.toContain("/private/workspace");
    expect(response.body).not.toContain("must-not-leak");
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("accepts a bounded canonical Base64 ZIP and rejects extra fields before service execution", async () => {
    const service = serviceMock();
    service.installSkill.mockResolvedValue(skillRecord());
    const app = Fastify();
    apps.push(app);
    registerAgentExtensionRoutes(app, { service: service as never, adminGuard: vi.fn(async () => undefined) as never });
    const archive = Buffer.from("PK\u0003\u0004test", "binary");
    const installed = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/skills",
      payload: { agentId: "agent-a", archiveBase64: archive.toString("base64") }
    });
    expect(installed.statusCode).toBe(201);
    expect(service.installSkill).toHaveBeenCalledWith({
      agentId: "agent-a",
      archive,
      replace: undefined
    });

    const injected = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/skills",
      payload: { agentId: "agent-a", archiveBase64: archive.toString("base64"), hostPath: "/tmp/archive.zip" }
    });
    expect(injected.statusCode).toBe(400);
    expect(service.installSkill).toHaveBeenCalledTimes(1);
    const invalidAgent = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/skills",
      payload: { agentId: "../agent-a", archiveBase64: archive.toString("base64") }
    });
    expect(invalidAgent.statusCode).toBe(400);
  });

  it("does not register cross-Agent apply or MCP mutation routes", async () => {
    const service = serviceMock();
    const app = Fastify();
    apps.push(app);
    registerAgentExtensionRoutes(app, { service: service as never, adminGuard: vi.fn(async () => undefined) as never });

    const requests = [
      { method: "POST", url: "/api/agent-extensions/skills/copy" },
      { method: "PUT", url: "/api/agent-extensions/mcp/servers" },
      { method: "POST", url: "/api/agent-extensions/mcp/servers/copy" },
      { method: "PATCH", url: "/api/agent-extensions/mcp/servers/github-mcp" },
      { method: "DELETE", url: "/api/agent-extensions/mcp/servers/github-mcp" },
      { method: "PUT", url: "/api/agent-extensions/mcp/secrets" }
    ] as const;
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        payload: { token: "super-secret-value", Authorization: "Bearer sk-forbidden" }
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("super-secret-value");
      expect(response.body).not.toContain("sk-forbidden");
    }
    expect(service.copySkill).not.toHaveBeenCalled();
    expect(service.putMcpServer).not.toHaveBeenCalled();
    expect(service.copyMcpServer).not.toHaveBeenCalled();
    expect(service.setMcpServerEnabled).not.toHaveBeenCalled();
    expect(service.removeMcpServer).not.toHaveBeenCalled();
  });

  it("exposes guarded strict lifecycle and copy-preview routes", async () => {
    const service = serviceMock();
    service.setSkillEnabled.mockResolvedValue({ ...skillRecord(), enabled: false });
    service.uninstallSkill.mockResolvedValue(skillRecord());
    service.previewCopy.mockResolvedValue(copyPreview());
    const guard = vi.fn(async () => undefined);
    const app = Fastify();
    apps.push(app);
    registerAgentExtensionRoutes(app, { service: service as never, adminGuard: guard as never });

    const preview = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/skills/copy/preview",
      payload: {
        sourceAgentId: "agent-a",
        targetAgentId: "agent-b",
        skillId: "test-skill",
        mcpServerIds: ["github-mcp"]
      }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().skill.declaredMcpDependenciesStatus).toBe("missing");
    expect(service.previewCopy).toHaveBeenCalledWith({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: "test-skill",
      mcpServerIds: ["github-mcp"]
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/agent-extensions/skills/test-skill",
      payload: { agentId: "agent-a", enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/agent-extensions/skills/test-skill?agentId=agent-a"
    });
    expect(removed.statusCode).toBe(200);
    expect(guard).toHaveBeenCalledTimes(3);

    const extra = await app.inject({
      method: "PATCH",
      url: "/api/agent-extensions/skills/test-skill",
      payload: { agentId: "agent-a", enabled: false, secret: "must-not-leak" }
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain("must-not-leak");
    expect(service.setSkillEnabled).toHaveBeenCalledTimes(1);
  });

  it.each(["EIO", "ELOOP"])("sanitizes %s repository failures at the API boundary", async (code) => {
    const privatePath = "/private/workspace/business/agents/agent-a/extensions/mcp/servers.json";
    const repository = {
      readSkillIndex: vi.fn().mockRejectedValue(Object.assign(
        new Error(`${code}: read failure, open '${privatePath}'`),
        { code, syscall: "open", path: privatePath }
      )),
      readMcpServerIndex: vi.fn().mockResolvedValue({ schemaVersion: 1, revision: "0".repeat(64), servers: [] })
    };
    const app = Fastify();
    apps.push(app);
    registerAgentExtensionRoutes(app, {
      service: new AgentExtensionService(repository as never),
      adminGuard: vi.fn(async () => undefined) as never
    });
    const response = await app.inject({ method: "GET", url: "/api/agent-extensions?agentId=agent-a" });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Agent 扩展存储暂时不可用");
    expect(response.body).not.toContain("/private/workspace");
    expect(response.body).not.toContain("servers.json");
  });

  it("returns the same closed 503 for resolver throws in overview and copy preview", async () => {
    const privatePath = "/private/workspace/business/agents/agent-a/extensions/mcp/servers.json";
    const secretValue = "Bearer resolver-route-secret";
    const server = mcpDescriptor();
    const repository = {
      readSkillIndex: vi.fn().mockResolvedValue({ schemaVersion: 1, revision: "0".repeat(64), skills: [] }),
      readMcpServerIndex: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        revision: "0".repeat(64),
        servers: [server]
      }),
      previewCopy: vi.fn(async (input: {
        credentialStatus: (query: { agentId: string; serverId: string; envKeys: string[] }) => Promise<unknown>;
      }) => {
        await input.credentialStatus({ agentId: "agent-a", serverId: server.id, envKeys: server.envKeys });
        return copyPreview();
      })
    };
    const service = new AgentExtensionService(repository as never, async () => {
      throw Object.assign(new Error(`${secretValue} at ${privatePath}`), {
        cause: secretValue,
        path: privatePath
      });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const loggerOutput: string[] = [];
    const app = Fastify({
      logger: {
        stream: { write: (chunk: string) => loggerOutput.push(chunk) }
      }
    });
    apps.push(app);
    registerAgentExtensionRoutes(app, {
      service,
      adminGuard: vi.fn(async () => undefined) as never
    });

    const responses = [
      await app.inject({ method: "GET", url: "/api/agent-extensions?agentId=agent-a" }),
      await app.inject({
        method: "POST",
        url: "/api/agent-extensions/skills/copy/preview",
        payload: {
          sourceAgentId: "agent-a",
          targetAgentId: "agent-b",
          skillId: "test-skill",
          mcpServerIds: ["github-mcp"]
        }
      })
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("AGENT_EXTENSION_CREDENTIAL_STATUS_INVALID");
      expect(response.body).toContain("MCP 凭据状态暂时不可用");
      expect(response.body).not.toContain(secretValue);
      expect(response.body).not.toContain(privatePath);
      expect(response.body).not.toContain("cause");
    }
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(loggerOutput.join("\n")).not.toContain(secretValue);
    expect(loggerOutput.join("\n")).not.toContain(privatePath);
  });
});

function serviceMock() {
  return {
    overview: vi.fn(),
    installSkill: vi.fn(),
    copySkill: vi.fn(),
    putMcpServer: vi.fn(),
    copyMcpServer: vi.fn(),
    previewCopy: vi.fn(),
    setSkillEnabled: vi.fn(),
    uninstallSkill: vi.fn(),
    setMcpServerEnabled: vi.fn(),
    removeMcpServer: vi.fn(),
  };
}

function skillRecord() {
  return {
    id: "test-skill",
    name: "test-skill",
    description: "Handles tests when the user asks for the test workflow.",
    license: null,
    compatibility: null,
    metadata: {},
    allowedTools: ["Read"],
    riskEvidence: {
      reviewVersion: 1,
      reviewStatus: "unreviewed",
      reviewedDigestSha256: null,
      classification: "instruction-only",
      hasScripts: false,
      hasExternalUrls: true,
      mcpDependencies: [{
        id: "github-mcp",
        description: "Repository tools",
        transport: "streamable_http",
        url: "https://mcp.example.test/v1/"
      }],
      declaredFileAccess: ["read"],
      allowImplicitInvocation: false
    },
    enabled: true,
    entry: "SKILL.md",
    digestSha256: "a".repeat(64),
    fileCount: 1,
    unpackedBytes: 100,
    installedAt: "2026-07-17T00:00:00.000Z",
    source: { kind: "upload" }
  };
}

function mcpDescriptor() {
  return {
    id: "github-mcp",
    name: "GitHub MCP",
    description: "Provides repository tools.",
    enabled: true,
    transport: "stdio",
    command: "/usr/bin/github-mcp",
    args: ["--stdio"],
    envKeys: ["GITHUB_TOKEN"]
  };
}

function copyPreview() {
  return {
    schemaVersion: 1,
    sourceAgentId: "agent-a",
    targetAgentId: "agent-b",
    skill: {
      record: skillRecord(),
      contentVersion: "a".repeat(64),
      files: [{ path: "SKILL.md", bytes: 100, sha256: "b".repeat(64) }],
      conflict: "none",
      declaredMcpDependencies: skillRecord().riskEvidence.mcpDependencies,
      declaredMcpDependenciesStatus: "missing",
      missingMcpDependencies: ["github-mcp"]
    },
    selectedMcpServers: [{
      server: mcpDescriptor(),
      descriptorVersion: "c".repeat(64),
      conflict: "none",
      sourceSecrets: { configuredKeys: ["GITHUB_TOKEN"], missingKeys: [] },
      targetSecrets: { configuredKeys: [], missingKeys: ["GITHUB_TOKEN"] }
    }]
  };
}
