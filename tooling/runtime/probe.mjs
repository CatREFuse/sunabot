import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectMultiAgentMigrationGate } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { inspectFirstRunBootstrap } from "./first-run-state.mjs";
import { inspectMcpRuntimeConfiguration } from "./mcp-runtime-config.mjs";

export const RUNTIME_PROBE_SCHEMA_VERSION = 1;

const VALID_KINDS = new Set(["liveness", "readiness", "capability"]);
const VALID_STATUSES = new Set(["pass", "warn", "fail", "unknown"]);
const CODEX_HEALTH_CLIENT_VERSION = "0.0.0";
const DEFAULT_PROVIDER_HEALTH_TIMEOUT_MS = 5_000;

export async function collectWorkspaceProbeFacts(options) {
  const workspace = path.resolve(options.workspace);
  const conflicts = [...(options.conflicts ?? [])];
  let workspaceStat;
  let workspaceSafe = true;
  let migrationState = "invalid";
  try {
    const gate = await inspectMultiAgentMigrationGate(workspace);
    workspaceStat = await fs.lstat(workspace).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    migrationState = gate.state === "trusted" ? "trusted" : gate.state;
  } catch (error) {
    workspaceSafe = error?.code !== "WORKSPACE_INVALID";
    if (workspaceSafe) {
      try {
        const firstRun = await inspectFirstRunBootstrap(workspace);
        migrationState = firstRun.state === "active" ? "resumable" : "invalid";
      } catch (firstRunError) {
        conflicts.push({
          id: "workspace-migration-state",
          code: firstRunError?.code ?? error?.code ?? "WORKSPACE_STATE_INVALID",
          path: workspace,
          action: "./sunabot.sh doctor",
          detail: safeMessage(firstRunError)
        });
      }
    } else {
      conflicts.push({
        id: "workspace-path",
        code: error?.code ?? "WORKSPACE_INVALID",
        path: workspace,
        action: "./sunabot.sh doctor",
        detail: safeMessage(error)
      });
    }
  }

  const provider = workspaceSafe
    ? await inspectProvider(workspace, options)
    : {
        configured: false,
        verifiedAvailable: false,
        ok: false,
        path: path.join(workspace, "business/config/sunabot.json"),
        detail: "workspace path is invalid"
      };
  const mcp = await inspectMcpRuntimeConfiguration({ environment: options.environment ?? process.env });
  const connected = options.connectedAccountIds == null
    ? undefined
    : new Set(options.connectedAccountIds.map(String));
  const observed = new Map(Object.entries(options.accountObservations ?? {}));
  const accounts = [];
  const databasePath = path.join(workspace, "business/data/sunabot.sqlite");
  if (workspaceSafe && await regularFile(databasePath)) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
      const rows = database.prepare(`
        SELECT aa.id, aa.agent_id, aa.enabled, a.enabled AS agent_enabled
        FROM agent_accounts aa
        JOIN agents a ON a.id = aa.agent_id
        ORDER BY aa.created_at, aa.id
      `).all();
      for (const row of rows) {
        const accountId = String(row.id);
        const desiredState = Number(row.enabled) === 1 && Number(row.agent_enabled) === 1 ? "running" : "stopped";
        const runtimeState = await readRuntimeState(workspace, accountId);
        const observedState = normalizeObservedState(observed.get(accountId) ?? runtimeState?.observedState);
        accounts.push({
          id: accountId,
          agentId: String(row.agent_id),
          desiredState,
          observedState,
          connected: connected ? connected.has(accountId) : null,
          reconcileRequired: runtimeState?.reconcileRequired === true || (
            desiredState === "running" ? observedState !== "running" : observedState === "running"
          ),
          lastError: typeof runtimeState?.lastError === "string" ? runtimeState.lastError : null,
          path: path.join(workspace, "runtime/napcat/accounts", accountId)
        });
      }
    } catch (error) {
      conflicts.push({
        id: "account-registry",
        code: "ACCOUNT_REGISTRY_UNREADABLE",
        path: databasePath,
        action: "./sunabot.sh doctor",
        detail: safeMessage(error)
      });
    } finally {
      database?.close();
    }
  }

  return {
    workspace: {
      path: workspace,
      exists: Boolean(workspaceStat?.isDirectory() && !workspaceStat.isSymbolicLink()),
      migrationState
    },
    capabilities: { provider, mcpOAuth: mcp.oauth, mcpStdio: mcp.stdio },
    accounts,
    conflicts
  };
}

export function buildRuntimeProbe(facts, options = {}) {
  const checks = [];
  const add = (input) => {
    const check = normalizeCheck(input);
    checks.push(check);
    return check;
  };
  const workspace = facts.workspace ?? {};
  const core = facts.core ?? {};
  const dependencies = facts.dependencies ?? {};
  const capabilities = facts.capabilities ?? {};

  add({
    id: "workspace",
    kind: "readiness",
    status: workspace.exists === true && workspace.migrationState === "trusted" ? "pass" : "fail",
    code: workspace.exists !== true
      ? "WORKSPACE_MISSING"
      : workspace.migrationState === "fresh" || workspace.migrationState === "missing"
        ? "FIRST_RUN_REQUIRED"
        : workspace.migrationState === "resumable" ? "FIRST_RUN_RESUME_REQUIRED" : "WORKSPACE_MIGRATION_REQUIRED",
    path: workspace.path,
    action: workspace.exists !== true
      || workspace.migrationState === "fresh"
      || workspace.migrationState === "missing"
      || workspace.migrationState === "resumable"
      ? "./sunabot.sh up"
      : "npm run migrate:multi-agent -- --workspace <绝对路径>",
    detail: workspace.migrationState ?? (workspace.exists ? "unknown" : "missing")
  });
  add({
    id: "core-process",
    kind: "liveness",
    status: core.running === true ? "pass" : "fail",
    code: "CORE_STOPPED",
    action: "./sunabot.sh up",
    detail: core.mode ?? "stopped"
  });
  add({
    id: "core-api",
    kind: "liveness",
    status: core.apiReady === true ? "pass" : "fail",
    code: "CORE_API_UNAVAILABLE",
    path: core.apiPath,
    action: "./sunabot.sh logs",
    detail: core.apiReady === true ? "ready" : "unavailable"
  });
  add({
    id: "onebot-listener",
    kind: "readiness",
    status: core.onebotReady === true ? "pass" : "fail",
    code: "ONEBOT_LISTENER_UNAVAILABLE",
    path: core.onebotPath,
    action: "./sunabot.sh doctor",
    detail: core.onebotReady === true ? "ready" : "unavailable"
  });

  addOptionalCapability(add, "node", dependencies.node, "NODE_VERSION_MISMATCH", "安装 .node-version 指定的 Node.js");
  addOptionalCapability(add, "docker", dependencies.docker, "DOCKER_UNAVAILABLE", "启动 Docker Engine");
  addOptionalCapability(add, "compose", dependencies.compose, "DOCKER_COMPOSE_UNAVAILABLE", "安装 Docker Compose 插件");
  addOptionalReadiness(add, "provider", capabilities.provider, "PROVIDER_NOT_READY", "在管理台选择并测试默认 Provider");
  addOptionalCapability(add, "codex-cli", capabilities.codexCli, "CODEX_CLI_UNAVAILABLE", "安装 runtime contract 指定版本的 Codex CLI");
  addOptionalCapability(add, "codex-auth", capabilities.codexAuth, "CODEX_AUTH_REQUIRED", "在管理台完成 Codex 订阅登录");
  addOptionalCapability(add, "workspace-bash", capabilities.workspaceBash, "BUBBLEWRAP_UNAVAILABLE", "安装 bubblewrap 并通过 namespace probe");
  addOptionalCapability(add, "mcp-oauth", capabilities.mcpOAuth, "MCP_OAUTH_VAULT_UNAVAILABLE", "设置 SUNABOT_MCP_CREDENTIAL_VAULT_KEY");
  addOptionalCapability(add, "mcp-stdio", capabilities.mcpStdio, "MCP_STDIO_RUNTIME_UNAVAILABLE", "配置 MCP stdio 隔离后端");
  addOptionalCapability(add, "account-reconciler", capabilities.accountReconciler, "ACCOUNT_RECONCILER_UNAVAILABLE", "./sunabot.sh restart");
  addOptionalCapability(add, "webfetch-dynamic-renderer", capabilities.webfetchDynamicRenderer,
    "WEBFETCH_RENDERER_UNAVAILABLE", "./sunabot.sh restart");

  for (const conflict of facts.conflicts ?? []) {
    add({
      id: conflict.id ?? "runtime-conflict",
      kind: conflict.kind ?? "readiness",
      status: "fail",
      code: conflict.code ?? "RUNTIME_CONFLICT",
      path: conflict.path,
      action: conflict.action ?? "./sunabot.sh doctor",
      detail: conflict.detail ?? "conflict"
    });
  }

  const accounts = (facts.accounts ?? []).map((account) => normalizeAccount(account));
  for (const account of accounts) {
    if (account.reconcileRequired) {
      add({
        id: `account:${account.id}`,
        kind: "readiness",
        status: "fail",
        code: account.lastError ? "ACCOUNT_RECONCILE_FAILED" : "ACCOUNT_RECONCILE_REQUIRED",
        path: account.path,
        action: `./sunabot.sh reconcile-account --account=${account.id}`,
        detail: account.lastError ?? `${account.desiredState}/${account.observedState}`
      });
    } else if (account.desiredState === "running" && account.connected === false) {
      add({
        id: `account:${account.id}`,
        kind: "readiness",
        status: "warn",
        code: "ACCOUNT_QQ_OFFLINE",
        path: account.path,
        action: "在管理台扫描 QQ 登录二维码",
        detail: account.observedState
      });
    }
  }

  const livenessChecks = checks.filter((item) => item.kind === "liveness");
  const readinessChecks = checks.filter((item) => item.kind === "readiness");
  const capabilityChecks = checks.filter((item) => item.kind === "capability");
  return {
    schemaVersion: RUNTIME_PROBE_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    summary: {
      liveness: livenessChecks.some((item) => item.status === "fail") ? "dead" : "live",
      readiness: readinessChecks.some((item) => item.status === "fail")
        ? "not_ready"
        : readinessChecks.some((item) => item.status === "warn") ? "degraded" : "ready",
      capability: capabilityChecks.some((item) => item.status === "fail") ? "degraded" : "ready"
    },
    checks,
    accounts
  };
}

function addOptionalCapability(add, id, fact, code, action) {
  if (fact == null) return;
  const normalized = typeof fact === "boolean" ? { ok: fact } : fact;
  add({
    id,
    kind: "capability",
    status: normalized.ok === true ? "pass" : normalized.ok === false ? "fail" : "unknown",
    code,
    path: normalized.path,
    action: normalized.action ?? action,
    detail: normalized.detail ?? (normalized.ok ? "available" : "unavailable")
  });
}

function addOptionalReadiness(add, id, fact, code, action) {
  if (fact == null) return;
  const normalized = typeof fact === "boolean" ? { ok: fact } : fact;
  add({
    id,
    kind: "readiness",
    status: normalized.ok === true ? "pass" : normalized.ok === false ? "fail" : "unknown",
    code,
    path: normalized.path,
    action: normalized.action ?? action,
    detail: normalized.detail ?? (normalized.ok ? "ready" : "not ready")
  });
}

function normalizeCheck(input) {
  const kind = VALID_KINDS.has(input.kind) ? input.kind : "readiness";
  const status = VALID_STATUSES.has(input.status) ? input.status : "unknown";
  return {
    id: String(input.id),
    kind,
    status,
    code: status === "pass" ? null : String(input.code ?? "PROBE_UNKNOWN"),
    path: input.path == null ? null : String(input.path),
    action: status === "pass" ? null : String(input.action ?? "./sunabot.sh doctor"),
    detail: String(input.detail ?? status)
  };
}

function normalizeAccount(account) {
  const desiredState = account.desiredState === "stopped" ? "stopped" : "running";
  const observedState = ["running", "stopped", "missing", "unknown"].includes(account.observedState)
    ? account.observedState
    : "unknown";
  return {
    id: String(account.id),
    agentId: String(account.agentId ?? ""),
    desiredState,
    observedState,
    connected: account.connected === true ? true : account.connected === false ? false : null,
    reconcileRequired: account.reconcileRequired === true || (
      desiredState === "running" ? observedState !== "running" : observedState === "running"
    ),
    lastError: typeof account.lastError === "string" && account.lastError.trim() ? account.lastError.trim() : null,
    path: account.path == null ? null : String(account.path)
  };
}

async function inspectProvider(workspace, options = {}) {
  const configPath = path.join(workspace, "business/config/sunabot.json");
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const defaultProviderId = String(config.providers?.defaultProviderId ?? "").trim();
    const provider = Array.isArray(config.providers?.items)
      ? config.providers.items.find((item) => item?.id === defaultProviderId)
      : undefined;
    const selected = Boolean(defaultProviderId && provider?.enabled);
    const credential = selected ? await providerCredential(workspace, provider) : "";
    const configured = selected && Boolean(credential);
    const verification = configured
      ? await verifyProviderAvailability(provider, credential, options.providerProbeTimeoutMs)
      : { available: false, detail: selected ? "credential missing" : "default Provider is disabled or missing" };
    return {
      configured,
      verifiedAvailable: verification.available,
      ok: configured && verification.available,
      path: configPath,
      detail: defaultProviderId
        ? `default=${defaultProviderId}; configured=${configured}; health=${verification.detail}`
        : "default Provider is not selected"
    };
  } catch (error) {
    return {
      configured: false,
      verifiedAvailable: false,
      ok: false,
      path: configPath,
      detail: error?.code === "ENOENT" ? "configuration missing" : safeMessage(error)
    };
  }
}

async function providerCredential(workspace, provider) {
  const name = String(provider?.apiKeyEnv ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "";
  if (process.env[name]?.trim()) return process.env[name].trim();
  const references = [...new Set([provider?.envFile, "workspace/secrets/runtime.env"].filter(Boolean))];
  for (const reference of references) {
    const filePath = providerEnvironmentPath(workspace, String(reference));
    if (!filePath || !await regularFile(filePath)) continue;
    const value = environmentValue(await fs.readFile(filePath, "utf8"), name);
    if (value) return value;
  }
  if (provider?.kind === "codex-responses") {
    const authPath = path.join(workspace, "secrets/codex/auth.json");
    if (await regularFile(authPath)) {
      try {
        const payload = JSON.parse(await fs.readFile(authPath, "utf8"));
        const token = String(payload?.tokens?.access_token ?? "").trim();
        if (token && !jwtExpired(token)) return token;
      } catch {}
    }
  }
  return "";
}

function jwtExpired(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp * 1_000 <= Date.now();
  } catch {
    return false;
  }
}

function providerEnvironmentPath(workspace, reference) {
  const normalized = reference.replaceAll("\\", "/").trim();
  const target = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : normalized.startsWith("workspace/")
      ? path.resolve(workspace, normalized.slice("workspace/".length))
      : path.resolve(workspace, normalized);
  const relative = path.relative(workspace, target);
  return !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? target : undefined;
}

function environmentValue(source, name) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== name) continue;
    const value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1).trim();
    }
    return value.replace(/\s+#.*$/, "").trim();
  }
  return "";
}

async function verifyProviderAvailability(provider, credential, timeoutInput) {
  const timeoutMs = Number.isFinite(Number(timeoutInput))
    ? Math.min(5_000, Math.max(50, Number(timeoutInput)))
    : DEFAULT_PROVIDER_HEALTH_TIMEOUT_MS;
  const endpoint = providerHealthEndpoint(provider, credential);
  if (!endpoint) return { available: false, detail: "health endpoint unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = providerHealthHeaders(provider, credential);
    const response = await fetch(endpoint, { method: "GET", headers, signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return {
      available: response.ok,
      detail: response.ok ? `verified ${response.status}` : `health HTTP ${response.status}`
    };
  } catch (error) {
    return {
      available: false,
      detail: error?.name === "AbortError" ? `health timeout ${timeoutMs}ms` : safeMessage(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function providerHealthEndpoint(provider) {
  const kind = String(provider?.kind ?? "");
  if (kind.startsWith("gemini-")) {
    const base = String(provider?.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const versioned = /\/v\d+(?:beta\d*)?$/.test(base) ? base : `${base}/v1beta`;
    return new URL(`${versioned}/models`).toString();
  }
  let base = String(provider?.baseUrl || defaultProviderBaseUrl(kind)).replace(/\/+$/, "");
  if (!base) return undefined;
  if (kind === "openai-official" && !base.endsWith("/v1")) base = `${base}/v1`;
  if (kind.startsWith("anthropic-") && !/\/v\d+$/.test(base)) base = `${base}/v1`;
  if (kind === "codex-responses") {
    const endpoint = new URL(`${base}/models`);
    endpoint.searchParams.set("client_version", CODEX_HEALTH_CLIENT_VERSION);
    return endpoint.toString();
  }
  return `${base}/models`;
}

function defaultProviderBaseUrl(kind) {
  if (kind === "openai-official" || kind === "openai-compatible") return "https://api.openai.com/v1";
  if (kind.startsWith("anthropic-")) return "https://api.anthropic.com/v1";
  if (kind === "codex-responses") return "https://chatgpt.com/backend-api/codex";
  return "";
}

function providerHealthHeaders(provider, credential) {
  const kind = String(provider?.kind ?? "");
  if (kind.startsWith("gemini-")) return { accept: "application/json", "x-goog-api-key": credential };
  if (kind.startsWith("anthropic-")) {
    return { accept: "application/json", "x-api-key": credential, "anthropic-version": "2023-06-01" };
  }
  if (kind === "codex-responses") {
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${credential}`,
      "user-agent": "codex_cli_rs/0.0.0 (Sunabot)",
      originator: "codex_cli_rs"
    };
    const accountId = codexAccountId(credential);
    return accountId ? { ...headers, "chatgpt-account-id": accountId } : headers;
  }
  return { accept: "application/json", authorization: `Bearer ${credential}` };
}

function codexAccountId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function readRuntimeState(workspace, accountId) {
  const filePath = path.join(workspace, "runtime/napcat/accounts", accountId, "runtime-state.json");
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    return value?.schemaVersion === 1 && value.accountId === accountId ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function regularFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeObservedState(value) {
  return ["running", "stopped", "missing", "unknown"].includes(value) ? value : "unknown";
}

function safeMessage(value) {
  return (value instanceof Error ? value.message : String(value ?? "unknown"))
    .replaceAll(/[\r\n]+/g, " ")
    .slice(0, 1_000);
}
