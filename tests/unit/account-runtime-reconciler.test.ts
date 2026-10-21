// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("forces only the selected running account to restart", () => {
    expect(planAccountReconciliation({
      accountId: "qq_arona",
      account: { id: "qq_arona", enabled: true, agentEnabled: true },
      containers: [
        { id: "primary-container", accountId: "primary", state: "running" },
        { id: "arona-container", accountId: "qq_arona", state: "running" }
      ],
      forceRestart: true
    })).toMatchObject({
      action: "restart",
      targetContainerIds: ["arona-container"],
      reconcileRequired: true
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

  it("requests a forced restart through the workspace queue so Docker Core never needs the Docker socket", async () => {
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
      const pending = reconciler.restart("qq_arona");
      const requests = path.join(workspace, "runtime/account-reconciler/requests");
      let requestFile = "";
      for (let index = 0; index < 100 && !requestFile; index += 1) {
        requestFile = (await fs.readdir(requests).catch(() => []))
          .find((name) => /^[a-f0-9-]{36}\.json$/.test(name)) ?? "";
        if (!requestFile) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(requestFile).toMatch(/^[a-f0-9-]{36}\.json$/);
      const request = JSON.parse(await fs.readFile(path.join(requests, requestFile), "utf8"));
      expect(request).toMatchObject({ kind: "account-reconcile", accountId: "qq_arona", forceRestart: true });
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

describe("runtime probe request sharing", () => {
  const workspaces: string[] = [];
  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => fs.rm(workspace, { recursive: true, force: true })));
  });

  async function createFixture() {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-probe-sharing-"));
    workspaces.push(workspace);
    await fs.mkdir(path.join(workspace, "runtime"), { recursive: true });
    await fs.writeFile(path.join(workspace, "runtime/launcher-state.json"), JSON.stringify({ reconciler: { pid: 42 } }));
    const requestsDirectory = path.join(workspace, "runtime/account-reconciler/requests");
    const resultsDirectory = path.join(workspace, "runtime/account-reconciler/results");
    await fs.mkdir(requestsDirectory, { recursive: true });
    await fs.mkdir(resultsDirectory, { recursive: true });
    const client = new RuntimeProbeClient({ workspace, pollIntervalMs: 5, timeoutMs: 1_000 });
    return {
      workspace,
      client,
      async requests() {
        const names = (await fs.readdir(requestsDirectory)).filter((name) => name.endsWith(".json"));
        return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(requestsDirectory, name), "utf8")) as {
          requestId: string; connectedAccountIds: string[];
        }));
      },
      async respond(requestId: string, reply: { facts?: Record<string, unknown>; error?: string }) {
        const resultPath = path.join(resultsDirectory, `${requestId}.json`);
        await fs.writeFile(`${resultPath}.tmp`, JSON.stringify({ schemaVersion: 1, kind: "runtime-probe", requestId, ...reply }));
        await fs.rename(`${resultPath}.tmp`, resultPath);
      }
    };
  }

  async function waitForRequests(fixture: Awaited<ReturnType<typeof createFixture>>, count = 1) {
    await vi.waitFor(async () => expect((await fixture.requests()).length).toBeGreaterThanOrEqual(count), { timeout: 500, interval: 5 });
    return fixture.requests();
  }

  it("shares one host probe for an equivalent connected account set", async () => {
    const fixture = await createFixture();
    const first = fixture.client.collectFacts({ connectedAccountIds: ["qq_arona", "primary", "primary"] });
    const second = fixture.client.collectFacts({ connectedAccountIds: ["primary", "qq_arona"] });
    await waitForRequests(fixture);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const requests = await fixture.requests();
    await Promise.all(requests.map((request) => fixture.respond(request.requestId, { facts: { core: { running: true } } })));
    const results = await Promise.all([first, second]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.connectedAccountIds).toEqual(["primary", "qq_arona"]);
    expect(results).toEqual([{ core: { running: true } }, { core: { running: true } }]);
  });

  it("expires successful facts after five seconds without extending the deadline on cache hits", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const fixture = await createFixture();
    const first = fixture.client.collectFacts({ connectedAccountIds: ["primary"] });
    const [request] = await waitForRequests(fixture);
    await fixture.respond(request!.requestId, { facts: { revision: 1 } });
    await expect(first).resolves.toEqual({ revision: 1 });

    clock.mockReturnValue(5_999);
    const cached = fixture.client.collectFacts({ connectedAccountIds: ["primary", "primary"] });
    const cachedOutcome = await Promise.race([cached, new Promise((resolve) => setTimeout(() => resolve("cache miss"), 25))]);
    if (cachedOutcome === "cache miss") {
      for (const pending of await fixture.requests()) await fixture.respond(pending.requestId, { facts: { unexpected: true } });
      await cached;
    }
    expect(cachedOutcome).toEqual({ revision: 1 });
    expect(await fixture.requests()).toEqual([]);

    clock.mockReturnValue(6_000);
    const expired = fixture.client.collectFacts({ connectedAccountIds: ["primary"] });
    const [next] = await waitForRequests(fixture);
    await fixture.respond(next!.requestId, { facts: { revision: 2 } });
    await expect(expired).resolves.toEqual({ revision: 2 });
  });

  it("does not cache a failed host probe and allows a fresh retry", async () => {
    const fixture = await createFixture();
    const failed = fixture.client.collectFacts({ connectedAccountIds: ["primary"] });
    const rejection = expect(failed).rejects.toThrow("synthetic host probe failure");
    const [request] = await waitForRequests(fixture);
    await fixture.respond(request!.requestId, { error: "synthetic host probe failure" });
    await rejection;
    const retry = fixture.client.collectFacts({ connectedAccountIds: ["primary"] });
    const [next] = await waitForRequests(fixture);
    expect(next!.requestId).not.toBe(request!.requestId);
    await fixture.respond(next!.requestId, { facts: { recovered: true } });
    await expect(retry).resolves.toEqual({ recovered: true });
  });

  it("invalidates completed facts when the set changes A to B to A", async () => {
    const fixture = await createFixture();
    const requestIds: string[] = [];
    for (const [revision, connectedAccountIds] of [[1, ["primary"]], [2, ["qq_arona"]], [3, ["primary"]]] as const) {
      const pending = fixture.client.collectFacts({ connectedAccountIds: [...connectedAccountIds] });
      const [request] = await waitForRequests(fixture);
      requestIds.push(request!.requestId);
      await fixture.respond(request!.requestId, { facts: { revision } });
      await expect(pending).resolves.toEqual({ revision });
    }
    expect(new Set(requestIds).size).toBe(3);
  });

  it("does not reuse or cache an older in-flight A after A to B to A", async () => {
    const fixture = await createFixture();
    const first = fixture.client.collectFacts({ connectedAccountIds: ["primary"] });
    const [oldA] = await waitForRequests(fixture);
    const second = fixture.client.collectFacts({ connectedAccountIds: ["qq_arona"] });
    const middle = (await waitForRequests(fixture, 2)).find((request) => request.connectedAccountIds[0] === "qq_arona")!;
    const third = fixture.client.collectFacts({ connectedAccountIds: ["primary"] });
    const currentA = (await waitForRequests(fixture, 3)).find((request) => request.connectedAccountIds[0] === "primary" && request.requestId !== oldA!.requestId)!;
    await fixture.respond(currentA.requestId, { facts: { revision: "current" } });
    await expect(third).resolves.toEqual({ revision: "current" });
    await fixture.respond(oldA!.requestId, { facts: { revision: "old" } });
    await fixture.respond(middle.requestId, { facts: { revision: "middle" } });
    await Promise.all([first, second]);
    await expect(fixture.client.collectFacts({ connectedAccountIds: ["primary"] })).resolves.toEqual({ revision: "current" });
    expect(await fixture.requests()).toEqual([]);
  });

  it("keeps different workspaces independent", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const pendingFirst = first.client.collectFacts({ connectedAccountIds: ["primary"] });
    const pendingSecond = second.client.collectFacts({ connectedAccountIds: ["primary"] });
    const [[requestFirst], [requestSecond]] = await Promise.all([waitForRequests(first), waitForRequests(second)]);
    await first.respond(requestFirst!.requestId, { facts: { workspace: "first" } });
    await second.respond(requestSecond!.requestId, { facts: { workspace: "second" } });
    await expect(pendingFirst).resolves.toEqual({ workspace: "first" });
    await expect(pendingSecond).resolves.toEqual({ workspace: "second" });
  });
});
