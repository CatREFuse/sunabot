// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  AgentMcpServerDescriptor,
  AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  AgentMcpHost,
  McpToolApprovalTransactions,
  SkillActivationService,
  type McpRuntimeClientPort
} from "../../services/extensions/public.js";
import {
  RuntimeAgentExtensions,
  applyRuntimeAgentExtensionPrompt
} from "../../src/runtime/agentExtensions.js";

describe("Runtime Agent extensions", () => {
  it("exposes only approved Skills and preserves activated instructions across prompt preparation", async () => {
    const approved = skill("approved", true);
    const hidden = skill("hidden", false);
    const repository = repositoryMock([approved, hidden], []);
    const reader = { read: vi.fn(async () => ({
      digestSha256: approved.digestSha256,
      instructions: "Follow the approved workflow.",
      resources: [{ path: "references/guide.md", bytes: 7, sha256: "c".repeat(64) }]
    })) };
    const runtime = new RuntimeAgentExtensions(
      repository,
      new SkillActivationService(reader),
      new AgentMcpHost({ create: vi.fn() })
    );

    const first = await runtime.prepare(runtimeInput());
    expect(first.systemTexts.join("\n")).toContain("approved");
    expect(first.systemTexts.join("\n")).not.toContain("hidden");
    expect(first.skills?.skillIds).toEqual(["approved"]);
    await expect(first.skills?.activate({ skillId: "hidden" })).rejects.toThrow("SKILL_UNAVAILABLE");
    await expect(first.skills?.activate({ skillId: "approved" })).resolves.toMatchObject({
      skillId: "approved",
      instructions: "Follow the approved workflow."
    });

    const second = await runtime.prepare(runtimeInput());
    expect(second.systemTexts).toContain(
      `[Protected activated Skill approved (${approved.digestSha256})]\nFollow the approved workflow.`
    );
    expect(reader.read).toHaveBeenCalledOnce();
  });

  it("keeps Skill script execution unavailable even when the caller requests script tools", async () => {
    const scriptSkill = skill("script-skill", true);
    scriptSkill.riskEvidence.classification = "script-bearing";
    scriptSkill.riskEvidence.hasScripts = true;
    const reader = { read: vi.fn() };
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([scriptSkill], []),
      new SkillActivationService(reader),
      new AgentMcpHost({ create: vi.fn() })
    );

    const prepared = await runtime.prepare(runtimeInput());
    expect(prepared.skills).toBeDefined();
    expect(prepared.skills?.runScript).toBeUndefined();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("binds dynamic MCP calls to the current Agent, server and explicit approval decision", async () => {
    const client = clientMock();
    const approve = vi.fn(async () => true);
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [server("server-a")]),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn(async () => client) }),
      approve
    );
    const prepared = await runtime.prepare(runtimeInput({ conversationId: "group:10" }));
    const definition = prepared.mcp?.definitions()[0] as { name: string };
    await expect(prepared.mcp?.call({
      name: definition.name,
      arguments: { query: "status" },
      callId: "call-1"
    })).resolves.toEqual({ ok: true });
    expect(approve).toHaveBeenCalledWith({
      agentId: "agent-a",
      accountId: "primary",
      transport: "onebot",
      conversationId: "group:10",
      userId: 1,
      serverId: "server-a",
      toolName: "search",
      snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      catalogGeneration: 1,
      approvalMode: "always",
      arguments: { query: "status" },
      callId: "call-1"
    });
    expect(client.callTool).toHaveBeenCalledOnce();
  });

  it("injects only the current Agent ready MCP instructions as protected external prompt hints", async () => {
    const clientA = clientMock();
    const clientB = clientMock();
    clientA.instructions = "Use Agent A search for local records.";
    clientB.instructions = "Use Agent B search for another tenant.";
    const host = new AgentMcpHost({
      create: vi.fn(async ({ agentId }: { agentId: string }) => agentId === "agent-a" ? clientA : clientB)
    });
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [server("server-a")]),
      new SkillActivationService({ read: vi.fn() }),
      host
    );

    const preparedA = await runtime.prepare(runtimeInput());
    const preparedB = await runtime.prepare(runtimeInput({
      agentId: "agent-b",
      conversationId: "private:2",
      userId: 2
    }));
    const textA = preparedA.systemTexts.join("\n");
    const textB = preparedB.systemTexts.join("\n");
    expect(textA).toContain("[Protected MCP selection hints]");
    expect(textA).toContain("[External MCP input] Use Agent A search for local records.");
    expect(textA).not.toContain("Agent B search");
    expect(textB).toContain("[External MCP input] Use Agent B search for another tenant.");
    expect(textB).not.toContain("Agent A search");
    const prompt = applyRuntimeAgentExtensionPrompt({
      messages: [{ role: "user", content: "find it" }],
      response_format: { type: "text" }
    }, preparedA);
    expect(prompt.messages).toContainEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("Use Agent A search for local records.")
    }));
  });

  it("bounds the combined ready MCP instruction hint budget", async () => {
    const servers = Array.from({ length: 24 }, (_, index) => server(`server-${String(index).padStart(2, "0")}`));
    const host = new AgentMcpHost({ create: vi.fn(async () => {
      const client = clientMock();
      client.instructions = "x".repeat(512);
      return client;
    }) });
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], servers),
      new SkillActivationService({ read: vi.fn() }),
      host
    );

    const prepared = await runtime.prepare(runtimeInput());
    const hints = prepared.systemTexts.find((text) => text.startsWith("[Protected MCP selection hints]"));
    expect(hints).toBeDefined();
    expect(Buffer.byteLength(hints!, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(hints).not.toContain("server-23");
  });

  it("reports required server startup failure without affecting other Agents", async () => {
    const host = new AgentMcpHost({ create: vi.fn(async () => { throw new Error("offline"); }) });
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [server("required", true)]),
      new SkillActivationService({ read: vi.fn() }),
      host
    );
    await expect(runtime.prepare(runtimeInput()))
      .resolves.toMatchObject({ requiredMcpFailures: ["required"] });
    await expect(new RuntimeAgentExtensions(
      repositoryMock([], []),
      new SkillActivationService({ read: vi.fn() }),
      host
    ).prepare(runtimeInput({ agentId: "agent-b", conversationId: "private:2", userId: 2 })))
      .resolves.toMatchObject({ requiredMcpFailures: [] });
  });

  it("issues a chat confirmation ticket and consumes it only after the exact next-user command", async () => {
    const client = clientMock();
    const approvals = new McpToolApprovalTransactions({ now: () => 1_000 });
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [server("server-a")]),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn(async () => client) }),
      (request) => approvals.resolve(request),
      approvals
    );
    const first = await runtime.prepare(runtimeInput());
    const definition = first.mcp?.definitions()[0] as { name: string };
    const pending = await first.mcp?.call({
      name: definition.name,
      arguments: { query: "status" },
      callId: "call-1"
    }) as { approvalRequired: boolean; confirmationText: string };
    expect(pending).toMatchObject({ approvalRequired: true });
    expect(client.callTool).not.toHaveBeenCalled();

    await runtime.prepare(runtimeInput({
      confirmationText: pending.confirmationText,
      accountId: "secondary"
    }));
    const confirmed = await runtime.prepare(runtimeInput({ confirmationText: pending.confirmationText }));
    await expect(confirmed.mcp?.call({
      name: definition.name,
      arguments: { query: "status" },
      callId: "call-2"
    })).resolves.toEqual({ ok: true });
    expect(client.callTool).toHaveBeenCalledOnce();
    await expect(confirmed.mcp?.call({
      name: definition.name,
      arguments: { query: "status" },
      callId: "call-3"
    })).resolves.toMatchObject({ approvalRequired: true });
    expect(client.callTool).toHaveBeenCalledOnce();
  });

  it("tries bounded MCP confirmation messages separately in sequence order and stops on success", async () => {
    const exact = `/确认 MCP mcpa_${"a".repeat(24)}`;
    const confirm = vi.fn((text: string) => text === exact);
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], []),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn() }),
      () => false,
      {
        confirm,
        clearConversation: vi.fn(),
        clearAgent: vi.fn(),
        clear: vi.fn()
      }
    );
    await runtime.prepare(runtimeInput({
      confirmationTexts: [
        "invalid\0command",
        "x".repeat(513),
        "not a confirmation",
        exact,
        "must not be attempted"
      ]
    }));
    expect(confirm.mock.calls.map(([text]) => text)).toEqual([
      "not a confirmation",
      exact
    ]);
    expect(confirm).not.toHaveBeenCalledWith("not a confirmation\n" + exact, expect.anything());
  });

  it("never lets an ordinary chat sender self-approve credential-bearing MCP tools", async () => {
    const client = clientMock();
    const approvals = new McpToolApprovalTransactions({ now: () => 1_000 });
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [server("server-a")]),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn(async () => client) }),
      (request) => approvals.resolve(request),
      approvals
    );
    const prepared = await runtime.prepare(runtimeInput({ canApproveMcpTools: false, userId: 99 }));
    expect(prepared.mcp).toBeUndefined();
    expect(approvals.list("agent-a")).toEqual([]);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("allows an ordinary sender only through an administrator-configured never-approval allowlist", async () => {
    const client = clientMock();
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [{
        ...server("server-a"),
        approvalMode: "never",
        ordinaryUserTools: ["search"]
      }]),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn(async () => client) })
    );
    const prepared = await runtime.prepare(runtimeInput({ canApproveMcpTools: false, userId: 99 }));
    const definition = prepared.mcp?.definitions()[0] as { name: string };
    await expect(prepared.mcp?.call({
      name: definition.name, arguments: { query: "public" }, callId: "ordinary-safe"
    })).resolves.toEqual({ ok: true });
    expect(client.callTool).toHaveBeenCalledOnce();
  });

  it.each([
    { enabledTools: undefined, ordinaryUserTools: ["search"] },
    { enabledTools: ["search"], ordinaryUserTools: undefined },
    { enabledTools: ["search"], ordinaryUserTools: ["search"], disabledTools: ["search"] },
    { enabledTools: ["search"], ordinaryUserTools: ["search"], envKeys: ["SERVER_TOKEN"] }
  ])("hides ordinary MCP tools unless every host allowlist gate is explicit: %#", async (policy) => {
    const client = clientMock();
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [{ ...server("server-a"), approvalMode: "never", ...policy }]),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn(async () => client) })
    );
    const prepared = await runtime.prepare(runtimeInput({ canApproveMcpTools: false, userId: 99 }));
    expect(prepared.mcp).toBeUndefined();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("does not expose a newly announced tool to ordinary users without explicit policy", async () => {
    const client = clientMock();
    let listChanged = () => undefined;
    client.setListChangedHandler.mockImplementation((handler: () => void) => { listChanged = handler; });
    const runtime = new RuntimeAgentExtensions(
      repositoryMock([], [{
        ...server("server-a"), approvalMode: "never", ordinaryUserTools: ["search"]
      }]),
      new SkillActivationService({ read: vi.fn() }),
      new AgentMcpHost({ create: vi.fn(async () => client) })
    );
    const first = await runtime.prepare(runtimeInput({ canApproveMcpTools: false, userId: 99 }));
    expect(first.mcp?.definitions()).toHaveLength(1);
    client.listTools.mockResolvedValue({ items: [
      { name: "search", inputSchema: { type: "object" } },
      { name: "new-delete", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
    ] });
    listChanged();
    const refreshed = await runtime.prepare(runtimeInput({ canApproveMcpTools: false, userId: 99 }));
    expect(refreshed.mcp?.definitions()).toHaveLength(1);
    expect(JSON.stringify(refreshed.mcp?.definitions())).not.toContain("new-delete");
  });

  it("injects extension context after existing system messages and before conversation content", () => {
    const original = {
      messages: [
        { role: "system" as const, content: "base" },
        { role: "user" as const, content: "hello" }
      ],
      response_format: { type: "text" }
    };
    const changed = applyRuntimeAgentExtensionPrompt(original, {
      systemTexts: ["catalog", "protected"],
      requiredMcpFailures: []
    });
    expect(changed.messages.map((message) => message.content)).toEqual([
      "base", "catalog", "protected", "hello"
    ]);
    expect(original.messages.map((message) => message.content)).toEqual(["base", "hello"]);
  });
});

function repositoryMock(skills: AgentSkillRecord[], servers: AgentMcpServerDescriptor[]) {
  return {
    ensureLayout: vi.fn(async () => undefined),
    readSkillIndex: vi.fn(async () => ({ schemaVersion: 1 as const, revision: "skills", skills })),
    readMcpServerIndex: vi.fn(async () => ({ schemaVersion: 1 as const, revision: "mcp", servers }))
  };
}

function runtimeInput(overrides: Partial<{
  agentId: string;
  conversationId: string;
  accountId: string;
  transport: "onebot" | "web";
  userId: number;
  confirmationText: string;
  confirmationTexts: readonly string[];
  selectedSkillIds: string[];
  canApproveMcpTools: boolean;
}> = {}) {
  return {
    agentId: "agent-a",
    conversationId: "private:1",
    accountId: "primary",
    transport: "onebot" as const,
    userId: 1,
    canApproveMcpTools: true,
    ...overrides
  };
}

function skill(id: string, approved: boolean): AgentSkillRecord {
  const digestSha256 = approved ? "a".repeat(64) : "b".repeat(64);
  return {
    id,
    name: id,
    description: `Use ${id} when requested.`,
    license: null,
    compatibility: null,
    metadata: {},
    allowedTools: [],
    enabled: true,
    entry: "SKILL.md",
    digestSha256,
    fileCount: 1,
    unpackedBytes: 1,
    installedAt: "2026-07-17T00:00:00.000Z",
    source: { kind: "upload" },
    approval: {
      status: approved ? "approved" : "unapproved",
      digestSha256: approved ? digestSha256 : null,
      approvedAt: approved ? "2026-07-17T00:01:00.000Z" : null
    },
    riskEvidence: {
      reviewVersion: 1,
      reviewStatus: approved ? "approved" : "unreviewed",
      reviewedDigestSha256: approved ? digestSha256 : null,
      classification: "instruction-only",
      hasScripts: false,
      hasExternalUrls: false,
      mcpDependencies: [],
      declaredFileAccess: [],
      allowImplicitInvocation: true
    }
  };
}

function server(id: string, required = false): AgentMcpServerDescriptor {
  return {
    id,
    name: id,
    description: "Test server",
    enabled: true,
    required,
    enabledTools: ["search"],
    disabledTools: [],
    approvalMode: "always",
    transport: "stdio",
    command: "/usr/bin/test-mcp",
    args: [],
    envKeys: []
  };
}

function clientMock(): McpRuntimeClientPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: { tools: true },
    listTools: vi.fn(async () => ({
      items: [{ name: "search", description: "Search", inputSchema: { type: "object" } }]
    })),
    listResources: vi.fn(async () => ({ items: [] })),
    listResourceTemplates: vi.fn(async () => ({ items: [] })),
    listPrompts: vi.fn(async () => ({ items: [] })),
    callTool: vi.fn(async () => ({ ok: true })),
    readResource: vi.fn(async () => ({ contents: [] })),
    subscribeResource: vi.fn(async () => ({})),
    unsubscribeResource: vi.fn(async () => ({})),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    setListChangedHandler: vi.fn(),
    setResourceUpdatedHandler: vi.fn(),
    setRootsHandler: vi.fn(),
    commitCatalog: vi.fn(),
    close: vi.fn(async () => undefined)
  };
}
