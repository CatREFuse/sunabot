// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccountRuntimeReconciler,
  RuntimeProbeClient
} from "../../services/agents/accountRuntimeReconciler.js";
import {
  accountRuntimeState,
  planAccountReconciliation
} from "../../tooling/runtime/account-reconciler.mjs";

describe("account runtime reconciler", () => {
  it("starts only the newly registered target account", () => {
    expect(planAccountReconciliation({
      accountId: "qq_arona",
      account: { id: "qq_arona", enabled: true, agentEnabled: true },
      containers: [{ id: "primary-container", accountId: "primary", state: "running" }]
    })).toEqual({
      accountId: "qq_arona",
      desiredState: "running",
      observedState: "missing",
      action: "start",
      targetContainerIds: [],
      reconcileRequired: true
    });
  });

  it("is idempotent when the target account is already running", () => {
    expect(planAccountReconciliation({
      accountId: "qq_arona",
      account: { id: "qq_arona", enabled: true, agentEnabled: true },
      containers: [
        { id: "primary-container", accountId: "primary", state: "running" },
        { id: "arona-container", accountId: "qq_arona", state: "running" }
      ]
    })).toMatchObject({
      action: "verify",
      targetContainerIds: ["arona-container"],
      reconcileRequired: false
    });
  });

  it.each([
    { account: undefined, label: "removed" },
    { account: { id: "qq_arona", enabled: false, agentEnabled: true }, label: "disabled" },
    { account: { id: "qq_arona", enabled: true, agentEnabled: false }, label: "disabled Agent" }
  ])("removes only the target container when the account is $label", ({ account }) => {
    expect(planAccountReconciliation({
      accountId: "qq_arona",
      account,
      containers: [
        { id: "primary-container", accountId: "primary", state: "running" },
        { id: "arona-container", accountId: "qq_arona", state: "running" }
      ]
    })).toMatchObject({
      desiredState: "stopped",
      action: "remove",
      targetContainerIds: ["arona-container"],
      reconcileRequired: true
    });
  });

  it("serializes a bounded stable failure state", () => {
    expect(accountRuntimeState({
      accountId: "qq_arona",
      desiredState: "running",
      observedState: "missing",
      reconcileRequired: true,
      lastError: "Docker Engine unavailable"
    }, new Date("2026-07-14T12:00:00.000Z"))).toEqual({
      schemaVersion: 1,
      accountId: "qq_arona",
      desiredState: "running",
      observedState: "missing",
      reconcileRequired: true,
      lastError: "Docker Engine unavailable",
      updatedAt: "2026-07-14T12:00:00.000Z"
    });
  });

  it("uses the workspace queue so Docker Core never needs the Docker socket", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-account-reconciler-"));
    try {
      const databasePath = path.join(workspace, "business/data/sunabot.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE agents (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
        CREATE TABLE agent_accounts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, enabled INTEGER NOT NULL);
        INSERT INTO agents VALUES ('plana', 1);
        INSERT INTO agent_accounts VALUES ('qq_arona', 'plana', 1);
      `);
      database.close();
      await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
      await fs.writeFile(path.join(workspace, "runtime/launcher-state.json"), JSON.stringify({
        reconciler: { pid: 42 }
      }));
      const reconciler = new AccountRuntimeReconciler({ workspace, pollIntervalMs: 5, timeoutMs: 1_000 });
      const pending = reconciler.reconcile("qq_arona");
      const requests = path.join(workspace, "runtime/account-reconciler/requests");
      let requestFile = "";
      for (let index = 0; index < 100 && !requestFile; index += 1) {
        requestFile = (await fs.readdir(requests).catch(() => []))
          .find((name) => /^[a-f0-9-]{36}\.json$/.test(name)) ?? "";
        if (!requestFile) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(requestFile).toMatch(/^[a-f0-9-]{36}\.json$/);
      const request = JSON.parse(await fs.readFile(path.join(requests, requestFile), "utf8"));
      const results = path.join(workspace, "runtime/account-reconciler/results");
      await fs.mkdir(results, { recursive: true });
      await fs.writeFile(path.join(results, requestFile), JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        accountId: "qq_arona",
        state: {
          schemaVersion: 1,
          accountId: "qq_arona",
          desiredState: "running",
          observedState: "running",
          reconcileRequired: false,
          lastError: null,
          updatedAt: "2026-07-14T12:00:00.000Z"
        }
      }));

      await expect(pending).resolves.toMatchObject({ observedState: "running", reconcileRequired: false });
      await expect(fs.readdir(requests)).resolves.toEqual([]);
      await expect(fs.readdir(results)).resolves.toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("persists the stable failure when the host reconciler is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-account-reconciler-missing-"));
    try {
      const databasePath = path.join(workspace, "business/data/sunabot.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE agents (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
        CREATE TABLE agent_accounts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, enabled INTEGER NOT NULL);
        INSERT INTO agents VALUES ('plana', 1);
        INSERT INTO agent_accounts VALUES ('qq_arona', 'plana', 1);
      `);
      database.close();

      const result = await new AccountRuntimeReconciler({ workspace }).reconcile("qq_arona");
      const persisted = JSON.parse(await fs.readFile(path.join(
        workspace,
        "runtime/napcat/accounts/qq_arona/runtime-state.json"
      ), "utf8"));

      expect(result).toMatchObject({
        accountId: "qq_arona",
        desiredState: "running",
        observedState: "unknown",
        reconcileRequired: true
      });
      expect(persisted).toEqual(result);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed without queuing a stop plan when the account registry is unreadable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-account-registry-invalid-"));
    try {
      await fs.mkdir(path.join(workspace, "business/data"), { recursive: true });
      await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
      await fs.writeFile(path.join(workspace, "business/data/sunabot.sqlite"), "not sqlite");
      await fs.writeFile(path.join(workspace, "runtime/launcher-state.json"), JSON.stringify({
        reconciler: { pid: 42 }
      }));

      const result = await new AccountRuntimeReconciler({
        workspace,
        pollIntervalMs: 5,
        timeoutMs: 30
      }).reconcile("qq_arona");

      expect(result).toMatchObject({
        desiredState: "running",
        observedState: "unknown",
        reconcileRequired: true,
        lastError: expect.stringContaining("ACCOUNT_REGISTRY_UNREADABLE")
      });
      const requests = await fs.readdir(path.join(workspace, "runtime/account-reconciler/requests")).catch(() => []);
      expect(requests).toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads host probe facts through the same workspace bridge", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-probe-client-"));
    try {
      await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
      await fs.writeFile(path.join(workspace, "runtime/launcher-state.json"), JSON.stringify({
        reconciler: { pid: 42 }
      }));
      const client = new RuntimeProbeClient({ workspace, pollIntervalMs: 5, timeoutMs: 1_000 });
      const pending = client.collectFacts({ connectedAccountIds: ["primary"] });
      const requests = path.join(workspace, "runtime/account-reconciler/requests");
      let requestFile = "";
      for (let index = 0; index < 100 && !requestFile; index += 1) {
        requestFile = (await fs.readdir(requests).catch(() => []))
          .find((name) => /^[a-f0-9-]{36}\.json$/.test(name)) ?? "";
        if (!requestFile) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const request = JSON.parse(await fs.readFile(path.join(requests, requestFile), "utf8"));
      expect(request).toMatchObject({ kind: "runtime-probe", connectedAccountIds: ["primary"] });
      const results = path.join(workspace, "runtime/account-reconciler/results");
      await fs.mkdir(results, { recursive: true });
      await fs.writeFile(path.join(results, requestFile), JSON.stringify({
        schemaVersion: 1,
        kind: "runtime-probe",
        requestId: request.requestId,
        facts: {
          workspace: { exists: true, migrationState: "trusted", path: workspace },
          core: { running: true, apiReady: true, onebotReady: true }
        }
      }));

      await expect(pending).resolves.toMatchObject({
        workspace: { exists: true, migrationState: "trusted" },
        core: { running: true }
      });
      await expect(fs.readdir(requests)).resolves.toEqual([]);
      await expect(fs.readdir(results)).resolves.toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
