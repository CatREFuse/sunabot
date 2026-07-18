// @vitest-environment node
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeProbe, collectWorkspaceProbeFacts } from "../../tooling/runtime/probe.mjs";

const now = new Date("2026-07-14T12:00:00.000Z");
const temporaryDirectories: string[] = [];
const previousProviderProbeKey = process.env.SUNABOT_PROVIDER_PROBE_KEY;

afterEach(async () => {
  if (previousProviderProbeKey == null) delete process.env.SUNABOT_PROVIDER_PROBE_KEY;
  else process.env.SUNABOT_PROVIDER_PROBE_KEY = previousProviderProbeKey;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("versioned runtime readiness probe", () => {
  it("separates core liveness, readiness, and optional capabilities", () => {
    const report = buildRuntimeProbe({
      workspace: { exists: true, migrationState: "trusted", path: "/srv/sunabot/workspace" },
      core: {
        mode: "native",
        running: true,
        apiReady: true,
        onebotReady: true,
        apiPath: "http://127.0.0.1:8787/api/auth/session",
        onebotPath: "http://127.0.0.1:8788/healthz"
      },
      dependencies: { node: { ok: true }, docker: { ok: true }, compose: { ok: true } },
      capabilities: {
        provider: { ok: false, detail: "default Provider is not selected" },
        codexCli: { ok: true },
        codexAuth: { ok: false },
        workspaceBash: { ok: true }
      }
    }, { now });

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      summary: { liveness: "live", readiness: "not_ready", capability: "degraded" }
    });
    expect(report.checks.find((item: { id: string }) => item.id === "provider")).toMatchObject({
      kind: "readiness",
      status: "fail",
      code: "PROVIDER_NOT_READY",
      action: "在管理台选择并测试默认 Provider"
    });
    expect(report.checks.some((item: { id: string }) => item.id === "libreoffice")).toBe(false);
  });

  it("keeps a temporarily offline QQ as an account warning without killing Core", () => {
    const report = buildRuntimeProbe({
      workspace: { exists: true, migrationState: "trusted", path: "/workspace" },
      core: { mode: "docker", running: true, apiReady: true, onebotReady: true },
      accounts: [{
        id: "primary",
        agentId: "plana",
        desiredState: "running",
        observedState: "running",
        connected: false,
        reconcileRequired: false,
        path: "/workspace/runtime/napcat/accounts/primary"
      }]
    }, { now });

    expect(report.summary).toEqual({ liveness: "live", readiness: "degraded", capability: "ready" });
    expect(report.checks.find((item: { id: string }) => item.id === "account:primary")).toMatchObject({
      status: "warn",
      code: "ACCOUNT_QQ_OFFLINE"
    });
  });

  it("returns stable path and repair action when one target account needs reconciliation", () => {
    const report = buildRuntimeProbe({
      workspace: { exists: true, migrationState: "trusted", path: "/workspace" },
      core: { mode: "native", running: true, apiReady: true, onebotReady: true },
      accounts: [{
        id: "qq_arona",
        agentId: "arona",
        desiredState: "running",
        observedState: "missing",
        connected: false,
        lastError: "Docker Engine unavailable",
        path: "/workspace/runtime/napcat/accounts/qq_arona"
      }]
    }, { now });

    expect(report.summary).toMatchObject({ liveness: "live", readiness: "not_ready" });
    expect(report.checks.find((item: { id: string }) => item.id === "account:qq_arona")).toMatchObject({
      status: "fail",
      code: "ACCOUNT_RECONCILE_FAILED",
      path: "/workspace/runtime/napcat/accounts/qq_arona",
      action: "./sunabot.sh reconcile-account --account=qq_arona"
    });
  });

  it("routes an empty workspace to first-run setup", () => {
    const report = buildRuntimeProbe({
      workspace: { exists: true, migrationState: "fresh", path: "/workspace" },
      core: { mode: "stopped", running: false, apiReady: false, onebotReady: false }
    }, { now });

    expect(report.checks.find((item: { id: string }) => item.id === "workspace")).toMatchObject({
      code: "FIRST_RUN_REQUIRED",
      action: "./sunabot.sh up"
    });
  });

  it("does not mark an enabled Provider ready without credentials and a verified health response", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-provider-probe-"));
    temporaryDirectories.push(workspace);
    await fs.mkdir(path.join(workspace, "business/config"), { recursive: true });
    await fs.writeFile(path.join(workspace, "business/config/sunabot.json"), JSON.stringify({
      providers: {
        defaultProviderId: "fixture",
        items: [{
          id: "fixture",
          kind: "openai-compatible",
          enabled: true,
          model: "fixture-model",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKeyEnv: "SUNABOT_PROVIDER_PROBE_MISSING_KEY",
          envFile: "workspace/secrets/runtime.env"
        }]
      }
    }));

    const facts = await collectWorkspaceProbeFacts({ workspace, providerProbeTimeoutMs: 50 });

    expect(facts.capabilities.provider).toMatchObject({
      configured: false,
      verifiedAvailable: false,
      ok: false
    });
  });

  it("verifies Provider availability with a bounded read-only health request", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-provider-health-"));
    temporaryDirectories.push(workspace);
    const requests: Array<{
      method?: string;
      url?: string;
      authorization?: string;
      apiKey?: string | string[];
      anthropicVersion?: string | string[];
    }> = [];
    let healthStatus = 200;
    const server = http.createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"],
        anthropicVersion: request.headers["anthropic-version"]
      });
      response.writeHead(healthStatus, { "content-type": "application/json" });
      response.end('{"data":[]}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Provider health fixture failed to listen.");
      process.env.SUNABOT_PROVIDER_PROBE_KEY = "fixture-secret";
      await fs.mkdir(path.join(workspace, "business/config"), { recursive: true });
      await fs.writeFile(path.join(workspace, "business/config/sunabot.json"), JSON.stringify({
        providers: {
          defaultProviderId: "fixture",
          items: [{
            id: "fixture",
            kind: "openai-compatible",
            enabled: true,
            model: "fixture-model",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKeyEnv: "SUNABOT_PROVIDER_PROBE_KEY"
          }]
        }
      }));

      const available = await collectWorkspaceProbeFacts({ workspace, providerProbeTimeoutMs: 500 });
      expect(available.capabilities.provider).toMatchObject({
        configured: true,
        verifiedAvailable: true,
        ok: true
      });
      expect(requests[0]).toMatchObject({
        method: "GET",
        url: "/v1/models",
        authorization: "Bearer fixture-secret"
      });

      await fs.writeFile(path.join(workspace, "business/config/sunabot.json"), JSON.stringify({
        providers: {
          defaultProviderId: "fixture",
          items: [{
            id: "fixture",
            kind: "anthropic-official",
            enabled: true,
            model: "fixture-model",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKeyEnv: "SUNABOT_PROVIDER_PROBE_KEY"
          }]
        }
      }));
      const anthropic = await collectWorkspaceProbeFacts({ workspace, providerProbeTimeoutMs: 500 });
      expect(anthropic.capabilities.provider).toMatchObject({ configured: true, verifiedAvailable: true, ok: true });
      expect(requests[1]).toMatchObject({
        method: "GET",
        url: "/v1/models",
        apiKey: "fixture-secret",
        anthropicVersion: "2023-06-01"
      });
      expect(requests[1]?.authorization).toBeUndefined();

      healthStatus = 503;
      const failed = await collectWorkspaceProbeFacts({ workspace, providerProbeTimeoutMs: 500 });
      expect(failed.capabilities.provider).toMatchObject({
        configured: true,
        verifiedAvailable: false,
        ok: false,
        detail: expect.stringContaining("health HTTP 503")
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const unavailable = await collectWorkspaceProbeFacts({ workspace, providerProbeTimeoutMs: 100 });
    expect(unavailable.capabilities.provider).toMatchObject({
      configured: true,
      verifiedAvailable: false,
      ok: false
    });
  });

  it("authenticates Gemini health checks by header without persisting the key", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-gemini-health-"));
    temporaryDirectories.push(workspace);
    const requests: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"models":[]}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const secret = "gemini-fixture-secret";
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Gemini health fixture failed to listen.");
      process.env.SUNABOT_PROVIDER_PROBE_KEY = secret;
      await fs.mkdir(path.join(workspace, "business/config"), { recursive: true });
      await fs.writeFile(path.join(workspace, "business/config/sunabot.json"), JSON.stringify({
        providers: {
          defaultProviderId: "gemini",
          items: [{
            id: "gemini",
            kind: "gemini-official",
            enabled: true,
            model: "gemini-fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
            apiKeyEnv: "SUNABOT_PROVIDER_PROBE_KEY"
          }]
        }
      }));

      const facts = await collectWorkspaceProbeFacts({ workspace, providerProbeTimeoutMs: 500 });
      const serializedResult = JSON.stringify({ schemaVersion: 1, kind: "runtime-probe", facts });
      const bridgePath = path.join(
        workspace,
        "runtime/account-reconciler/results/00000000-0000-4000-8000-000000000000.json"
      );
      await fs.mkdir(path.dirname(bridgePath), { recursive: true });
      await fs.writeFile(bridgePath, serializedResult, "utf8");

      expect(facts.capabilities.provider).toMatchObject({ configured: true, verifiedAvailable: true, ok: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/v1beta/models");
      expect(requests[0]?.url).not.toContain(secret);
      expect(requests[0]?.headers["x-goog-api-key"]).toBe(secret);
      expect(facts.capabilities.provider.detail).not.toContain(secret);
      expect(serializedResult).not.toContain(secret);
      await expect(fs.readFile(bridgePath, "utf8")).resolves.not.toContain(secret);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("includes the required Codex client version in the health request", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-health-"));
    temporaryDirectories.push(workspace);
    const requests: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"models":[]}');
      }, 1_600);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const accountId = "account-fixture";
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId }
    })).toString("base64url");
    const token = `e30.${payload}.signature`;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Codex health fixture failed to listen.");
      process.env.SUNABOT_PROVIDER_PROBE_KEY = token;
      await fs.mkdir(path.join(workspace, "business/config"), { recursive: true });
      await fs.writeFile(path.join(workspace, "business/config/sunabot.json"), JSON.stringify({
        providers: {
          defaultProviderId: "codex",
          items: [{
            id: "codex",
            kind: "codex-responses",
            enabled: true,
            model: "gpt-fixture",
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKeyEnv: "SUNABOT_PROVIDER_PROBE_KEY"
          }]
        }
      }));

      const facts = await collectWorkspaceProbeFacts({ workspace });

      expect(facts.capabilities.provider).toMatchObject({ configured: true, verifiedAvailable: true, ok: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/models?client_version=0.0.0");
      expect(requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
      expect(requests[0]?.headers["chatgpt-account-id"]).toBe(accountId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
