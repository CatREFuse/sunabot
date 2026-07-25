// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import { extensionRevision } from "../../adapters/filesystem/agentSkillPersistence.js";
import { AgentExtensionService } from "../../services/extensions/public.js";
import { makeStoredZip, skillMarkdown } from "./agent-extension-fixtures.js";
import { testTempRoot } from "./test-temp-root.js";

const TEST_DATA_ROOT = testTempRoot("agent-extension-copy-transaction");
const SOURCE_OAUTH_HANDLE = `mcpcred_${"A".repeat(24)}`;
const SOURCE_STDIO_SECRET_VALUE = "source-stdio-secret-value";
const temporaryPaths: string[] = [];
let workspace = "";

beforeEach(async () => {
  await fs.mkdir(TEST_DATA_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_DATA_ROOT, 0o700);
  workspace = await fs.mkdtemp(path.join(TEST_DATA_ROOT, "copy-transaction-"));
  temporaryPaths.push(workspace);
  await fs.mkdir(path.join(workspace, "business/agents/agent-a"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(workspace, "business/agents/agent-b"), { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(workspace, "business/agents"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/agent-a"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/agent-b"), 0o700);
});

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((candidate) => fs.rm(candidate, {
    recursive: true,
    force: true
  })));
});

describe("Agent extension copy transaction recovery", () => {
  it.each<string>([
    "after-copy-skill-install",
    "after-copy-mcp-put-0",
    "after-copy-mcp-put-1",
    "before-copy-transaction-finalize"
  ])("recovers an interrupted transaction at %s to the exact old indexes", async (faultPoint) => {
    const setup = await setupReplacementCopy();
    const faultyStore = crashStore(faultPoint);
    const faultyService = new AgentExtensionService(faultyStore);
    const preview = await previewCopy(faultyService);

    await expect(applyCopy(faultyService, preview.previewRevision))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_SIMULATED_CRASH" });

    const activeBeforeRecovery = await activeCopyJournals();
    expect(activeBeforeRecovery).toHaveLength(1);
    const journalText = await fs.readFile(path.join(skillsRoot(), activeBeforeRecovery[0]!), "utf8");
    expect(journalText).toContain("SERVER_ONE_TOKEN");
    expect(journalText).not.toContain(SOURCE_STDIO_SECRET_VALUE);
    expect(journalText).not.toContain(SOURCE_OAUTH_HANDLE);
    expect(journalText).toContain("reauthorization_required");

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    expect(await recovered.readSkillIndex("agent-b")).toEqual(setup.beforeSkills);
    expect(await recovered.readMcpServerIndex("agent-b")).toEqual(setup.beforeMcp);
    expect(await fs.readFile(path.join(skillsRoot(), "test-skill/SKILL.md"), "utf8"))
      .toContain("Target original");
    expect(await activeCopyJournals()).toEqual([]);
    expect(await copyArchives()).toEqual([]);
    const rolledBack = (await fs.readdir(skillsRoot())).find((name) =>
      name.startsWith(".copy-rolled_back-transaction-"));
    expect(rolledBack).toBeTruthy();
    const terminalText = await fs.readFile(path.join(skillsRoot(), rolledBack!), "utf8");
    expect(terminalText).toContain("SERVER_ONE_TOKEN");
    expect(terminalText).not.toContain(SOURCE_STDIO_SECRET_VALUE);
    expect(terminalText).not.toContain(SOURCE_OAUTH_HANDLE);
  }, 40_000);

  it.each<[string, number]>([
    ["after-copy-source-archive", 1],
    ["after-copy-previous-archive", 2]
  ])("removes orphan archives after an interruption at %s", async (faultPoint, expectedArchives) => {
    const setup = await setupReplacementCopy();
    const faultyService = new AgentExtensionService(crashStore(faultPoint));
    const preview = await previewCopy(faultyService);

    await expect(applyCopy(faultyService, preview.previewRevision))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_SIMULATED_CRASH" });
    expect(await activeCopyJournals()).toEqual([]);
    expect(await copyArchives()).toHaveLength(expectedArchives);

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    expect(await copyArchives()).toEqual([]);
    expect(await recovered.readSkillIndex("agent-b")).toEqual(setup.beforeSkills);
    expect(await recovered.readMcpServerIndex("agent-b")).toEqual(setup.beforeMcp);
  }, 40_000);

  it("rolls back skip after applying only a non-conflicting MCP descriptor", async () => {
    const setup = await setupReplacementCopy();
    const service = new AgentExtensionService(crashStore("after-copy-mcp-put-0"));
    const preview = await previewCopy(service);
    await expect(service.applyCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: "test-skill",
      mcpServerIds: ["server-one", "server-two"],
      previewRevision: preview.previewRevision,
      conflictStrategy: "skip"
    })).rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_SIMULATED_CRASH" });

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    expect(await recovered.readSkillIndex("agent-b")).toEqual(setup.beforeSkills);
    expect(await recovered.readMcpServerIndex("agent-b")).toEqual(setup.beforeMcp);
  }, 40_000);

  it("rolls back a renamed Skill without touching the existing same-name target", async () => {
    const setup = await setupReplacementCopy();
    const service = new AgentExtensionService(crashStore("after-copy-skill-install"));
    const preview = await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: "test-skill",
      mcpServerIds: []
    });
    await expect(service.applyCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: "test-skill",
      mcpServerIds: [],
      previewRevision: preview.previewRevision,
      conflictStrategy: "rename",
      renameTo: "renamed-skill"
    })).rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_SIMULATED_CRASH" });

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    expect(await recovered.readSkillIndex("agent-b")).toEqual(setup.beforeSkills);
    expect(await recovered.readMcpServerIndex("agent-b")).toEqual(setup.beforeMcp);
    await expect(fs.access(path.join(skillsRoot(), "renamed-skill"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(skillsRoot(), "test-skill/SKILL.md"), "utf8"))
      .toContain("Target original");
  }, 40_000);

  it("rolls back an ordinary partial failure immediately and leaves one terminal audit record", async () => {
    const setup = await setupReplacementCopy();
    const faultyStore = new AgentExtensionStore({
      workspaceRoot: workspace,
      faultInjector(step) {
        if (step === "after-copy-mcp-put-0") {
          throw Object.assign(new Error("injected MCP failure"), { code: "INJECTED_MCP_FAILURE" });
        }
      }
    });
    const service = new AgentExtensionService(faultyStore);
    const preview = await previewCopy(service);

    await expect(applyCopy(service, preview.previewRevision))
      .rejects.toMatchObject({ code: "INJECTED_MCP_FAILURE" });
    expect(await faultyStore.readSkillIndex("agent-b")).toEqual(setup.beforeSkills);
    expect(await faultyStore.readMcpServerIndex("agent-b")).toEqual(setup.beforeMcp);
    expect(await activeCopyJournals()).toEqual([]);
    expect(await copyArchives()).toEqual([]);
    expect((await fs.readdir(skillsRoot())).filter((name) =>
      name.startsWith(".copy-rolled_back-transaction-"))).toHaveLength(1);
  }, 40_000);

  it("holds one target transaction lock so same-store and cross-store writes fail before mutation", async () => {
    await setupReplacementCopy();
    const concurrentStore = new AgentExtensionStore({ workspaceRoot: workspace });
    let pauseApply!: () => void;
    let resumeApply!: () => void;
    const paused = new Promise<void>((resolve) => { pauseApply = resolve; });
    const resume = new Promise<void>((resolve) => { resumeApply = resolve; });
    let reached = false;
    const applyingStore = new AgentExtensionStore({
      workspaceRoot: workspace,
      async faultInjector(step) {
        if (step !== "after-copy-skill-install" || reached) return;
        reached = true;
        pauseApply();
        await resume;
      }
    });
    const service = new AgentExtensionService(applyingStore);
    const preview = await previewCopy(service);
    const applying = applyCopy(service, preview.previewRevision);
    await paused;
    try {
      const [sameStoreError, crossStoreError] = await Promise.all([
        applyingStore.putMcpServer({
          agentId: "agent-b",
          server: mcpDescriptor("same-store-edit", "/usr/bin/same-store-edit", [], false),
          replace: false
        }).then(() => undefined, (error: unknown) => error),
        concurrentStore.putMcpServer({
          agentId: "agent-b",
          server: mcpDescriptor("cross-store-edit", "/usr/bin/cross-store-edit", [], false),
          replace: false
        }).then(() => undefined, (error: unknown) => error)
      ]);
      expect(sameStoreError).toMatchObject({ code: "AGENT_EXTENSION_BUSY" });
      expect(crossStoreError).toMatchObject({ code: "AGENT_EXTENSION_BUSY" });
    } finally {
      resumeApply();
    }
    await applying;
    const serverIds = (await applyingStore.readMcpServerIndex("agent-b")).servers.map((server) => server.id);
    expect(serverIds).not.toContain("same-store-edit");
    expect(serverIds).not.toContain("cross-store-edit");
  }, 40_000);

  it("fails recovery closed without overwriting a later target MCP edit", async () => {
    await setupReplacementCopy();
    const faultyService = new AgentExtensionService(crashStore("after-copy-skill-install"));
    const preview = await previewCopy(faultyService);
    await expect(applyCopy(faultyService, preview.previewRevision))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_SIMULATED_CRASH" });

    const indexPath = mcpIndex();
    const current = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
      schemaVersion: 1;
      revision: string;
      servers: ReturnType<typeof mcpDescriptor>[];
    };
    const laterServer = mcpDescriptor("user-added", "/usr/bin/user-added", [], false);
    const servers = [...current.servers, laterServer].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    await fs.writeFile(indexPath, `${JSON.stringify({
      schemaVersion: 1,
      revision: extensionRevision(servers),
      servers
    }, null, 2)}\n`, { mode: 0o600 });

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await expect(recovered.ensureLayout("agent-b"))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_RECOVERY_REQUIRED" });
    const after = JSON.parse(await fs.readFile(indexPath, "utf8")) as { servers: Array<{ id: string }> };
    expect(after.servers.map((server) => server.id)).toContain("user-added");
    expect(await activeCopyJournals()).toHaveLength(1);
  }, 40_000);

  it("converges an active committed response-loss journal to the exact new state", async () => {
    await setupReplacementCopy();
    const service = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    const preview = await previewCopy(service);
    await applyCopy(service, preview.previewRevision);
    const committed = (await fs.readdir(skillsRoot())).find((name) =>
      name.startsWith(".copy-committed-transaction-"));
    expect(committed).toBeTruthy();
    const terminalText = await fs.readFile(path.join(skillsRoot(), committed!), "utf8");
    expect(terminalText).toContain("SERVER_ONE_TOKEN");
    expect(terminalText).not.toContain(SOURCE_STDIO_SECRET_VALUE);
    expect(terminalText).not.toContain(SOURCE_OAUTH_HANDLE);
    const id = committed!.slice(".copy-committed-transaction-".length, -".json".length);
    await fs.rename(
      path.join(skillsRoot(), committed!),
      path.join(skillsRoot(), `.copy-transaction-${id}.json`)
    );
    const beforeSkills = JSON.parse(await fs.readFile(skillIndex(), "utf8"));
    const beforeMcp = JSON.parse(await fs.readFile(mcpIndex(), "utf8"));

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    expect(await recovered.readSkillIndex("agent-b")).toEqual(beforeSkills);
    expect(await recovered.readMcpServerIndex("agent-b")).toEqual(beforeMcp);
    expect(await activeCopyJournals()).toEqual([]);
    expect(await copyArchives()).toEqual([]);
    expect(await fs.access(path.join(skillsRoot(), committed!)).then(() => true)).toBe(true);
  }, 40_000);

  it("removes bounded orphan archives before starting another target transaction", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.ensureLayout("agent-b");
    const id = "11111111-1111-4111-8111-111111111111";
    await fs.writeFile(path.join(skillsRoot(), `.copy-source-archive-${id}.zip`), "orphan", { mode: 0o600 });
    await fs.writeFile(path.join(skillsRoot(), `.copy-previous-archive-${id}.zip`), "orphan", { mode: 0o600 });

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    expect(await copyArchives()).toEqual([]);
  });

  it("retains terminal audits within deterministic count and total-byte limits", async () => {
    await setupReplacementCopy();
    const service = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    const preview = await previewCopy(service);
    await applyCopy(service, preview.previewRevision);
    const originalName = (await terminalCopyJournals())[0]!;
    const original = JSON.parse(await fs.readFile(path.join(skillsRoot(), originalName), "utf8"));
    for (let index = 0; index < 18; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const state = index % 2 === 0 ? "committed" : "rolled_back";
      const journal = {
        ...original,
        id,
        state,
        createdAt: `2099-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        sourceArchive: { ...original.sourceArchive, name: `.copy-source-archive-${id}.zip` },
        previousArchive: original.previousArchive
          ? { ...original.previousArchive, name: `.copy-previous-archive-${id}.zip` }
          : null
      };
      const padding = " ".repeat(512 * 1024);
      await fs.writeFile(
        path.join(skillsRoot(), `.copy-${state}-transaction-${id}.json`),
        `${JSON.stringify(journal)}${padding}\n`,
        { mode: 0o600 }
      );
    }
    const candidates = await terminalMetadata();
    const expected = [...candidates].sort(compareTerminalMetadata);
    let expectedBytes = expected.reduce((total, entry) => total + entry.bytes, 0);
    while (expected.length > 16 || expectedBytes > 8 * 1024 * 1024) {
      expectedBytes -= expected.shift()!.bytes;
    }

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await recovered.ensureLayout("agent-b");
    const retained = await terminalMetadata();
    expect(retained.map((entry) => entry.name).sort()).toEqual(expected.map((entry) => entry.name).sort());
    expect(retained).toHaveLength(expected.length);
    expect(retained.length).toBeLessThanOrEqual(16);
    expect(retained.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
  }, 40_000);

  it("fails closed without deleting a malformed terminal audit", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.ensureLayout("agent-b");
    const id = "22222222-2222-4222-8222-222222222222";
    const malformed = path.join(skillsRoot(), `.copy-committed-transaction-${id}.json`);
    await fs.writeFile(malformed, "{}\n", { mode: 0o600 });

    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await expect(recovered.ensureLayout("agent-b"))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_RECOVERY_REQUIRED" });
    expect(await fs.readFile(malformed, "utf8")).toBe("{}\n");
  });
});

async function setupReplacementCopy() {
  const store = new AgentExtensionStore({
    workspaceRoot: workspace,
    now: () => new Date("2026-07-17T00:00:00.000Z")
  });
  const service = new AgentExtensionService(store);
  await service.installSkill({ agentId: "agent-a", archive: skillZip("Source replacement") });
  await service.installSkill({ agentId: "agent-b", archive: skillZip("Target original") });
  await store.putMcpServer({
    agentId: "agent-a",
    server: mcpDescriptor("server-one", "/usr/bin/server-one", ["SERVER_ONE_TOKEN"]),
    replace: false
  });
  await store.putMcpServer({
    agentId: "agent-a",
    server: oauthMcpDescriptor("server-two", SOURCE_OAUTH_HANDLE),
    replace: false
  });
  await store.putMcpServer({
    agentId: "agent-b",
    server: mcpDescriptor("server-one", "/usr/bin/old-server-one", [], false),
    replace: false
  });
  return {
    beforeSkills: structuredClone(await store.readSkillIndex("agent-b")),
    beforeMcp: structuredClone(await store.readMcpServerIndex("agent-b"))
  };
}

function crashStore(faultPoint: string) {
  return new AgentExtensionStore({
    workspaceRoot: workspace,
    faultInjector(step) {
      if (step === faultPoint) {
        throw Object.assign(new Error(`simulated crash at ${step}`), {
          code: "AGENT_EXTENSION_COPY_SIMULATED_CRASH"
        });
      }
    }
  });
}

function previewCopy(service: AgentExtensionService) {
  return service.previewCopy({
    sourceAgentId: "agent-a",
    targetAgentId: "agent-b",
    skillId: "test-skill",
    mcpServerIds: ["server-one", "server-two"]
  });
}

function applyCopy(service: AgentExtensionService, previewRevision: string) {
  return service.applyCopy({
    sourceAgentId: "agent-a",
    targetAgentId: "agent-b",
    skillId: "test-skill",
    mcpServerIds: ["server-one", "server-two"],
    previewRevision,
    conflictStrategy: "replace"
  });
}

function skillZip(body: string) {
  return makeStoredZip([{ name: "SKILL.md", content: skillMarkdown("test-skill", undefined, body) }]);
}

function mcpDescriptor(
  id: string,
  command: string,
  envKeys: string[] = [],
  enabled = true
) {
  return {
    id,
    name: id,
    description: `${id} test server.`,
    enabled,
    transport: "stdio" as const,
    command,
    args: ["--stdio"],
    envKeys
  };
}

function oauthMcpDescriptor(id: string, credentialRef: string) {
  return {
    id,
    name: id,
    description: `${id} remote test server.`,
    enabled: true,
    required: true,
    enabledTools: [],
    disabledTools: [],
    approvalMode: "always" as const,
    transport: "streamable_http" as const,
    url: `https://extensions.example.test/${id}`,
    auth: { kind: "oauth" as const, credentialRef }
  };
}

function extensionsRoot() {
  return path.join(workspace, "business/agents/agent-b/extensions");
}

function skillsRoot() {
  return path.join(workspace, "business/agents/agent-b/workbench/skills");
}

function skillIndex() {
  return path.join(skillsRoot(), "index.json");
}

function mcpIndex() {
  return path.join(extensionsRoot(), "mcp/servers.json");
}

async function activeCopyJournals() {
  return (await fs.readdir(skillsRoot())).filter((name) =>
    /^\.copy-transaction-[0-9a-f-]+\.json$/u.test(name));
}

async function copyArchives() {
  return (await fs.readdir(skillsRoot())).filter((name) =>
    /^\.copy-(?:source|previous)-archive-[0-9a-f-]+\.zip$/u.test(name));
}

async function terminalCopyJournals() {
  return (await fs.readdir(skillsRoot())).filter((name) =>
    /^\.copy-(?:committed|rolled_back)-transaction-[0-9a-f-]+\.json$/u.test(name));
}

async function terminalMetadata() {
  return Promise.all((await terminalCopyJournals()).map(async (name) => {
    const filePath = path.join(skillsRoot(), name);
    const content = await fs.readFile(filePath, "utf8");
    return {
      name,
      bytes: (await fs.stat(filePath)).size,
      createdAt: (JSON.parse(content) as { createdAt: string }).createdAt,
      id: name.slice(name.lastIndexOf("transaction-") + "transaction-".length, -".json".length)
    };
  }));
}

function compareTerminalMetadata(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string }
) {
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 :
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
