// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => ({ workspace: "" }));

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  const nodePath = await import("node:path");
  return {
    ...actual,
    getWorkspacePath: (...segments: string[]) => nodePath.join(testPaths.workspace, ...segments),
    resolveProjectPath: (input: string | undefined) => {
      if (!input) return undefined;
      if (input === "workspace") return testPaths.workspace;
      if (input.startsWith("workspace/")) return nodePath.join(testPaths.workspace, input.slice("workspace/".length));
      return nodePath.isAbsolute(input) ? input : nodePath.resolve(input);
    }
  };
});

import { applicationDatabasePath, ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { registerAgentRoutes } from "../../apps/api/plugins/agentRoutes.js";
import {
  MULTI_AGENT_MIGRATION_MARKER,
  prepareFreshInstallMarker
} from "../../packages/platform/multiAgentMigrationGate.mjs";
import { AgentRegistry } from "../../services/agents/agentRegistry.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let temporaryDirectory = "";
let store: ApplicationDataStore;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-registry-"));
  testPaths.workspace = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(testPaths.workspace, { recursive: true });
  await prepareFreshInstallMarker(testPaths.workspace);
  store = new ApplicationDataStore(path.join(testPaths.workspace, "business", "data", "sunabot.sqlite"));
});

afterEach(async () => {
  store.close();
  testPaths.workspace = "";
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("AgentRegistry", () => {
  it("rejects a symbolic-link workspace parent before registry or filesystem writes", async () => {
    const unsafeRoot = path.join(temporaryDirectory, "unsafe-root");
    const external = path.join(temporaryDirectory, "external");
    const linkedParent = path.join(unsafeRoot, "linked-parent");
    await fs.mkdir(unsafeRoot, { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await fs.symlink(external, linkedParent, "dir");
    const createAgent = vi.fn();
    const registry = new AgentRegistry(createAdminTestConfig(temporaryDirectory), {
      workspaceRoot: path.join(linkedParent, "workspace/business/agents"),
      allowUnmarkedMigration: true,
      store: {
        readAgents: () => [],
        readAgent: () => undefined,
        createAgent,
        updateAgent: () => false,
        deleteAgent: () => false,
        readAgentAccounts: () => [],
        readAgentAccount: () => undefined,
        createAgentAccount: vi.fn(),
        updateAgentAccount: () => false,
        deleteAgentAccount: () => false,
        nextAgentAccountWebuiPort: () => 6100
      }
    });

    await expect(registry.initialize()).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });

    expect(createAgent).not.toHaveBeenCalled();
    await expect(fs.readdir(external)).resolves.toEqual([]);
  });

  it("rejects an unmarked workspace before creating the default Agent", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    const agentDirectory = path.join(testPaths.workspace, "business", "agents", "plana");
    config.persona.agentWorkspace = agentDirectory;
    await fs.rm(path.join(testPaths.workspace, MULTI_AGENT_MIGRATION_MARKER));
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.dirname(agentDirectory),
      store
    });

    await expect(registry.initialize()).rejects.toMatchObject({
      code: "MULTI_AGENT_MIGRATION_REQUIRED"
    });
    await expect(fs.access(path.join(agentDirectory, "agent.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.readAgents()).toEqual([]);
  });

  it("bootstraps the default Plana persona and Agent-level final prompts in a fresh workspace", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    const agentDirectory = path.join(testPaths.workspace, "business", "agents", "plana");
    config.persona.name = "普拉娜";
    config.persona.agentWorkspace = agentDirectory;
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.dirname(agentDirectory),
      store,
      allowUnmarkedMigration: true
    });

    await registry.initialize();

    const personaFiles = [
      "AGENTS.md",
      "SOUL.md",
      "PREFERENCE.md",
      "DIALOGUE_STYLE_EXAMPLES.md",
      "USER.md",
      "RELATION.md"
    ];
    for (const fileName of personaFiles) {
      await expect(fs.readFile(path.join(agentDirectory, fileName), "utf8")).resolves.toContain("普拉娜");
    }
    await expect(fs.readFile(path.join(agentDirectory, "selfie_prompt_rewrite.json"), "utf8"))
      .resolves.toContain("普拉娜");
  });

  it("fills missing default Plana files without overwriting legacy workspace customizations", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    const agentDirectory = path.join(testPaths.workspace, "business", "agents", "plana");
    const customAgents = "保留旧工作区的 Agent 规则。\n";
    const customSelfiePrompt = "{\"custom\":true}\n";
    config.persona.name = "普拉娜";
    config.persona.agentWorkspace = agentDirectory;
    await fs.mkdir(agentDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(agentDirectory, "AGENTS.md"), customAgents, "utf8"),
      fs.writeFile(path.join(agentDirectory, "selfie_prompt_rewrite.json"), customSelfiePrompt, "utf8")
    ]);
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.dirname(agentDirectory),
      store,
      allowUnmarkedMigration: true
    });

    await registry.initialize();

    await expect(fs.readFile(path.join(agentDirectory, "AGENTS.md"), "utf8")).resolves.toBe(customAgents);
    await expect(fs.readFile(path.join(agentDirectory, "selfie_prompt_rewrite.json"), "utf8"))
      .resolves.toBe(customSelfiePrompt);
    await expect(fs.readFile(path.join(agentDirectory, "SOUL.md"), "utf8")).resolves.toContain("普拉娜");
  });

  it("rejects symbolic links in shared system prompt paths", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    config.bot.memory.workMemoryCompressInPrompt = "nested/compress.json";
    const promptRoot = path.join(testPaths.workspace, "business", "prompts");
    const external = path.join(temporaryDirectory, "external-prompts");
    await fs.mkdir(promptRoot, { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await fs.symlink(external, path.join(promptRoot, "nested"), "dir");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true
    });

    await expect(registry.initialize()).rejects.toMatchObject({ code: "PROMPT_PATH_INVALID" });
    await expect(fs.access(path.join(external, "compress.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads legacy Agent manifests with current defaults for missing Bot fields", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true
    });
    await registry.initialize();
    const manifestPath = path.join(testPaths.workspace, "business", "agents", "plana", "agent.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete (manifest.bot as Record<string, unknown>).pokeOnNoReply;
    delete (manifest.bot as Record<string, unknown>).replyDebounceMs;
    delete (manifest.bot as Record<string, unknown>).quoteGroupReplyExcludedUserIds;
    delete (manifest.bot as Record<string, unknown>).tone;
    delete ((manifest.bot as Record<string, unknown>).orchestrator as Record<string, unknown>).groupThreadModel;
    delete ((manifest.bot as Record<string, unknown>).bash as Record<string, unknown>).adminPrivateBackend;
    delete ((manifest.bot as Record<string, unknown>).bash as Record<string, unknown>).auditModel;
    delete ((manifest.bot as Record<string, unknown>).bash as Record<string, unknown>).strictMode;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(registry.config("plana", config)).resolves.toMatchObject({
      bot: {
        replyDebounceMs: 5_000,
        pokeOnNoReply: false,
        quoteGroupReplyExcludedUserIds: [],
        tone: {
          enabled: false,
          providerId: "",
          model: "gpt-5.4-mini",
          maxRetries: 2
        },
        orchestrator: { groupThreadModel: "gpt-5.4-mini" },
        bash: {
          adminPrivateBackend: "native",
          auditModel: "gpt-5.4-mini",
          strictMode: true
        }
      }
    });
  });

  it("uses shared Thread model updates for Plana without overriding custom Agents", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    config.bot.orchestrator.groupThreadModel = "initial-thread-model";
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true
    });
    await registry.initialize();
    await registry.create({ id: "arona", name: "阿罗娜" });
    const updatedShared = structuredClone(config);
    updatedShared.bot.orchestrator.groupThreadModel = "updated-thread-model";

    await expect(registry.config("plana", updatedShared)).resolves.toMatchObject({
      bot: { orchestrator: { groupThreadModel: "updated-thread-model" } }
    });
    await expect(registry.config("arona", updatedShared)).resolves.toMatchObject({
      bot: { orchestrator: { groupThreadModel: "initial-thread-model" } }
    });
  });

  it("replaces an Agent WebUI avatar and keeps the manifest and registry in sync", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true,
      now: () => new Date("2026-07-13T08:00:00.000Z")
    });
    await registry.initialize();
    await registry.create({ id: "arona", name: "阿罗娜" });

    const first = await registry.updateAvatar("arona", {
      fileName: "arona.png",
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    });
    const firstPath = path.join(testPaths.workspace, "business", "agents", "arona", first.avatarPath!);
    await expect(fs.access(firstPath)).resolves.toBeUndefined();

    const second = await registry.updateAvatar("arona", {
      fileName: "arona.jpg",
      dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")
    });

    expect(second.avatarPath).toMatch(/^assets\/avatar-[A-Za-z0-9_-]+\.jpg$/);
    expect((await registry.manifest("arona")).avatarPath).toBe(second.avatarPath);
    expect((await registry.get("arona")).avatarPath).toBe(second.avatarPath);
    await expect(fs.access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      second.avatarPath!
    ))).resolves.toBeUndefined();

    const largeBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2 * 1024 * 1024 + 1)
    ]);
    const large = await registry.updateAvatar("arona", {
      fileName: "large-avatar.png",
      dataBase64: largeBytes.toString("base64")
    });
    const largePath = path.join(testPaths.workspace, "business", "agents", "arona", large.avatarPath!);
    expect((await fs.stat(largePath)).size).toBe(largeBytes.byteLength);
    expect((await registry.get("arona")).avatarPath).toBe(large.avatarPath);
  });

  it("migrates legacy NapCat state when the primary account is already registered", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.name = "普拉娜";
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true,
      now: () => new Date("2026-07-13T08:00:00.000Z")
    });
    await registry.initialize();
    await fs.mkdir(path.join(testPaths.workspace, "runtime", "napcat", "config-full"), { recursive: true });
    await fs.writeFile(path.join(
      testPaths.workspace,
      "runtime",
      "napcat",
      "config-full",
      "onebot11_123456789.json"
    ), "registered-primary\n", "utf8");

    await registry.initialize();

    await expect(fs.readFile(path.join(
      testPaths.workspace,
      "runtime",
      "napcat",
      "accounts",
      "primary",
      "config-full",
      "onebot11_123456789.json"
    ), "utf8")).resolves.toBe("registered-primary\n");
    expect(registry.account("primary")?.qqId).toBe("123456789");
  });

  it("creates isolated Agent workspaces and allocates unique QQ runtimes", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.name = "普拉娜";
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true,
      now: () => new Date("2026-07-13T08:00:00.000Z")
    });
    await fs.mkdir(path.join(
      testPaths.workspace,
      "runtime",
      "napcat",
      "accounts",
      "primary",
      "config-full"
    ), { recursive: true });
    await fs.mkdir(path.join(testPaths.workspace, "runtime", "napcat", "config-full"), { recursive: true });
    await fs.writeFile(path.join(
      testPaths.workspace,
      "runtime",
      "napcat",
      "config-full",
      "onebot11.json"
    ), "legacy-onebot\n", "utf8");
    await registry.initialize();

    await expect(fs.readFile(path.join(
      testPaths.workspace,
      "runtime",
      "napcat",
      "accounts",
      "primary",
      "config-full",
      "onebot11.json"
    ), "utf8")).resolves.toBe("legacy-onebot\n");

    const arona = await registry.create({
      id: "arona",
      name: "阿罗娜",
      avatar: {
        fileName: "arona.png",
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
      }
    });
    const first = await registry.createAccount(arona.id, { label: "阿罗娜主账号" });
    const second = await registry.createAccount(arona.id, { label: "阿罗娜备用账号" });

    expect(arona.workspace).toBe("workspace/business/agents/arona");
    expect(first.webuiPort).toBe(6100);
    expect(second.webuiPort).toBe(6101);
    await expect(fs.readFile(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      "AGENTS.md"
    ), "utf8")).resolves.toContain("你是阿罗娜");
    await expect(fs.readFile(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      "DIALOGUE_STYLE_EXAMPLES.md"
    ), "utf8")).resolves.toContain("必须严格遵从以下示例");
    await expect(fs.readFile(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      "selfie_prompt_rewrite.json"
    ), "utf8")).resolves.toContain("阿罗娜");
    await expect(fs.access(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      "assets",
      "avatar.png"
    ))).resolves.toBeUndefined();

    await registry.updateAccountIdentity(first.id, "123456789");
    await expect(registry.updateAccountIdentity(second.id, "123456789"))
      .rejects.toMatchObject({ statusCode: 409, code: "AGENT_CONFLICT" });

    const aronaConfig = await registry.config("arona", config);
    expect(aronaConfig.persona).toMatchObject({ defaultAgentId: "arona", name: "阿罗娜" });
    expect(aronaConfig.persona).toMatchObject({
      systemPromptOverride: false,
      systemPromptWorkspace: "workspace/business/prompts"
    });
    expect(aronaConfig.providers).toEqual(config.providers);
    expect(aronaConfig.bot).not.toBe(config.bot);
    const isolatedAgentWorkspace = path.join(testPaths.workspace, "business", "agents", "arona");
    const aronaDatabasePath = applicationDatabasePath({
      persona: { ...aronaConfig.persona, agentWorkspace: isolatedAgentWorkspace }
    });
    expect(aronaDatabasePath).toBe(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      "data",
      "sunabot.sqlite"
    ));
    const aronaStore = new ApplicationDataStore(aronaDatabasePath);
    try {
      store.setMetadata("isolation-probe", "plana");
      expect(aronaStore.metadata("isolation-probe")).toBeUndefined();
    } finally {
      aronaStore.close();
    }

    await registry.setSystemPromptOverride("arona", true);
    const aronaOverrideConfig = await registry.config("arona", config);
    expect(aronaOverrideConfig.persona).toMatchObject({
      systemPromptOverride: true,
      systemPromptWorkspace: "workspace/business/agents/arona/system-prompts"
    });
    await expect(fs.readFile(path.join(
      testPaths.workspace,
      "business",
      "agents",
      "arona",
      "system-prompts",
      "conversation_private_reply.json"
    ), "utf8")).resolves.toContain("@{persona.soul}");
    await registry.setSystemPromptOverride("arona", false);
    await expect(registry.promptSettings("arona")).resolves.toEqual({ overrideSystem: false });

    await expect(registry.removeAccount("plana", "primary")).rejects.toMatchObject({
      statusCode: 409,
      code: "PRIMARY_ACCOUNT_REQUIRED"
    });
    expect(registry.account("primary")).toMatchObject({ id: "primary", agentId: "plana" });

    await registry.removeAccount(arona.id, second.id);
    await expect(fs.access(path.join(
      testPaths.workspace,
      "runtime",
      "napcat",
      "accounts",
      second.id,
      ".remove-on-stop"
    ))).resolves.toBeUndefined();
  });

  it("removes the registry row and workspace when runtime initialization fails after creation", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true,
      now: () => new Date("2026-07-14T08:00:00.000Z")
    });
    await registry.initialize();
    const onAgentCreated = vi.fn(async () => {
      throw new Error("runtime initialization failed");
    });
    const app = Fastify();
    registerAgentRoutes(app, registry, { onAgentCreated });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { id: "arona", name: "阿罗娜" }
      });

      expect(response.statusCode).toBe(500);
      expect(onAgentCreated).toHaveBeenCalledWith("arona");
      expect(store.readAgent("arona")).toBeUndefined();
      await expect(fs.access(path.join(
        testPaths.workspace,
        "business",
        "agents",
        "arona"
      ))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(path.join(testPaths.workspace, "business", "agents")))
        .some((entry) => entry.startsWith(".rollback-arona-"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("reconciles only the target QQ after create, disable, and remove", async () => {
    const config = createAdminTestConfig(temporaryDirectory);
    config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
    const registry = new AgentRegistry(config, {
      workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
      store,
      allowUnmarkedMigration: true
    });
    await registry.initialize();
    const reconciled: string[] = [];
    const reconcileAccount = vi.fn(async (accountId: string) => {
      reconciled.push(accountId);
      const desiredState = registry.account(accountId)?.enabled === false || !registry.account(accountId)
        ? "stopped" as const
        : "running" as const;
      return {
        schemaVersion: 1 as const,
        accountId,
        desiredState,
        observedState: desiredState === "running" ? "running" as const : "missing" as const,
        reconcileRequired: false,
        lastError: null,
        updatedAt: "2026-07-14T12:00:00.000Z"
      };
    });
    const app = Fastify();
    registerAgentRoutes(app, registry, { reconcileAccount });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents/plana/accounts",
        payload: { label: "备用账号" }
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        desiredState: "running",
        observedState: "running",
        reconcileRequired: false
      });
      const accountId = created.json().id as string;
      expect(reconciled).toEqual([accountId]);
      expect(registry.account("primary")?.enabled).toBe(true);

      const disabled = await app.inject({
        method: "PATCH",
        url: `/api/agents/plana/accounts/${accountId}`,
        payload: { enabled: false }
      });
      expect(disabled.json()).toMatchObject({ desiredState: "stopped", observedState: "missing" });
      expect(registry.account(accountId)?.enabled).toBe(false);
      expect(registry.account("primary")?.enabled).toBe(true);

      const started = await app.inject({
        method: "POST",
        url: `/api/agents/plana/accounts/${accountId}/runtime/start`
      });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({
        id: accountId,
        enabled: true,
        desiredState: "running",
        observedState: "running",
        reconcileRequired: false
      });
      expect(registry.account(accountId)?.enabled).toBe(true);
      expect(registry.account("primary")?.enabled).toBe(true);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/agents/plana/accounts/${accountId}`
      });
      expect(removed.json()).toMatchObject({ ok: true });
      expect(registry.account(accountId)).toBeUndefined();
      expect(registry.account("primary")?.enabled).toBe(true);
      expect(reconciled).toEqual([accountId, accountId, accountId, accountId, accountId]);
    } finally {
      await app.close();
    }
  });
});
