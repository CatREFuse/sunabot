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

import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { registerAgentRoutes } from "../../apps/api/plugins/agentRoutes.js";
import { prepareFreshInstallMarker } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { AgentRegistry } from "../../services/agents/agentRegistry.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let temporaryDirectory = "";
let store: ApplicationDataStore;
let registry: AgentRegistry;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-removal-"));
  testPaths.workspace = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(testPaths.workspace, { recursive: true });
  await prepareFreshInstallMarker(testPaths.workspace);
  store = new ApplicationDataStore(path.join(testPaths.workspace, "business", "data", "sunabot.sqlite"));
  const config = createAdminTestConfig(temporaryDirectory);
  config.persona.agentWorkspace = path.join(testPaths.workspace, "business", "agents", "plana");
  registry = new AgentRegistry(config, {
    workspaceRoot: path.join(testPaths.workspace, "business", "agents"),
    store,
    allowUnmarkedMigration: true
  });
  await registry.initialize();
});

afterEach(async () => {
  store.close();
  testPaths.workspace = "";
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Agent 删除", () => {
  it("requires the confirmation phrase and preserves the primary Bot", async () => {
    const app = Fastify();
    registerAgentRoutes(app, registry);

    const missingConfirmation = await app.inject({
      method: "DELETE",
      url: "/api/agents/plana",
      payload: { confirmation: "删除" }
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json()).toMatchObject({ code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });

    const primary = await app.inject({
      method: "DELETE",
      url: "/api/agents/plana",
      payload: { confirmation: "确认删除" }
    });
    expect(primary.statusCode).toBe(409);
    expect(primary.json()).toMatchObject({ code: "PRIMARY_AGENT_REQUIRED" });
    await expect(registry.get("plana")).resolves.toMatchObject({ id: "plana" });
    await app.close();
  });

  it("stops account registration before removing the Bot workspace", async () => {
    const agent = await registry.create({ id: "arona", name: "阿罗娜" });
    const account = await registry.createAccount(agent.id, { label: "阿罗娜主账号" });
    const removalPrepared = vi.fn();
    let accountConnected = true;
    const app = Fastify();
    registerAgentRoutes(app, registry, {
      isAccountConnected: () => accountConnected,
      onAgentRemovalPrepared: removalPrepared
    });

    const connected = await app.inject({
      method: "DELETE",
      url: "/api/agents/arona",
      payload: { confirmation: "确认删除" }
    });
    expect(connected.statusCode).toBe(409);
    expect(connected.json()).toMatchObject({ code: "AGENT_ACCOUNT_CONNECTED" });
    await expect(registry.get("arona")).resolves.toMatchObject({ id: "arona" });
    accountConnected = false;

    const response = await app.inject({
      method: "DELETE",
      url: "/api/agents/arona",
      payload: { confirmation: "确认删除" }
    });

    expect(response.statusCode).toBe(200);
    expect(removalPrepared).toHaveBeenCalledWith(expect.objectContaining({ id: "arona" }));
    await expect(registry.get("arona")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(registry.account(account.id)).toBeUndefined();
    await expect(fs.access(path.join(testPaths.workspace, "business", "agents", "arona"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(testPaths.workspace, "runtime", "napcat", "accounts", account.id, ".remove-on-stop"), "utf8"))
      .resolves.toMatch(/T/);
    await app.close();
  });
});
