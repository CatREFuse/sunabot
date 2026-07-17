// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const testRoot = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/oauth-store";
const handle = `mcpcred_${"A".repeat(24)}`;
let root = "";

beforeEach(async () => {
  await fs.mkdir(testRoot, { recursive: true, mode: 0o700 });
  root = await fs.mkdtemp(path.join(testRoot, "case-"));
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, "business/agents/agent-a"), { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(root, "business"), 0o700);
  await fs.chmod(path.join(root, "business/agents"), 0o700);
  await fs.chmod(path.join(root, "business/agents/agent-a"), 0o700);
});

afterEach(async () => {
  const current = root;
  root = "";
  if (current) await fs.rm(current, { recursive: true, force: true });
});

describe("Agent MCP OAuth descriptor CAS", () => {
  it("atomically binds one opaque vault handle and rejects stale callbacks", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: root });
    await store.putMcpServer({ agentId: "agent-a", server: descriptor(), replace: false });
    const initial = await store.readMcpServerIndex("agent-a");
    await store.bindMcpOAuthCredential({
      agentId: "agent-a",
      serverId: "server-a",
      expectedRevision: initial.revision,
      expectedUrl: "https://mcp.example.test/mcp",
      credentialRef: handle
    });
    const bound = await store.readMcpServerIndex("agent-a");
    expect(bound.servers[0]).toMatchObject({ auth: { kind: "oauth", credentialRef: handle } });
    await expect(store.bindMcpOAuthCredential({
      agentId: "agent-a",
      serverId: "server-a",
      expectedRevision: initial.revision,
      expectedUrl: "https://mcp.example.test/mcp",
      credentialRef: `mcpcred_${"B".repeat(24)}`
    })).rejects.toMatchObject({ code: "MCP_INDEX_REVISION_CONFLICT" });
    expect((await store.readMcpServerIndex("agent-a")).servers[0])
      .toMatchObject({ auth: { credentialRef: handle } });
    await expectNoMcpLocks();
  });

  it("disables only the descriptor that still references the revoked handle", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: root });
    await store.putMcpServer({ agentId: "agent-a", server: { ...descriptor(), auth: {
      kind: "oauth", credentialRef: handle
    } }, replace: false });
    const index = await store.readMcpServerIndex("agent-a");
    await expect(store.disableMcpOAuthCredential({
      agentId: "agent-a", serverId: "server-a", expectedRevision: index.revision,
      expectedUrl: "https://mcp.example.test/mcp", credentialRef: `mcpcred_${"B".repeat(24)}`
    })).rejects.toMatchObject({ code: "MCP_OAUTH_BINDING_CONFLICT" });
    await store.disableMcpOAuthCredential({
      agentId: "agent-a", serverId: "server-a", expectedRevision: index.revision,
      expectedUrl: "https://mcp.example.test/mcp", credentialRef: handle
    });
    expect((await store.readMcpServerIndex("agent-a")).servers[0]).toMatchObject({ enabled: false });
    await expectNoMcpLocks();
  });
});

async function expectNoMcpLocks() {
  for (const lockPath of [
    path.join(root, "business/agents/agent-a/.extensions-layout.lock"),
    path.join(root, "business/agents/agent-a/extensions/mcp/.index.lock"),
    path.join(root, "business/agents/agent-a/extensions/skills/.copy.lock")
  ]) {
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function descriptor() {
  return {
    id: "server-a",
    name: "Server A",
    description: "Test",
    enabled: true,
    required: false,
    enabledTools: [],
    disabledTools: [],
    approvalMode: "always" as const,
    transport: "streamable_http" as const,
    url: "https://mcp.example.test/mcp",
    auth: { kind: "oauth" as const, credentialRef: "pending" }
  };
}
