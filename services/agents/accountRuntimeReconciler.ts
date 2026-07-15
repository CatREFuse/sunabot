import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getWorkspaceDir } from "../../src/config.js";

export interface AccountRuntimeState {
  schemaVersion: 1;
  accountId: string;
  desiredState: "running" | "stopped";
  observedState: "running" | "stopped" | "missing" | "unknown";
  reconcileRequired: boolean;
  lastError: string | null;
  updatedAt: string;
}

export interface AccountRuntimeReconcilerPort {
  reconcile(accountId: string): Promise<AccountRuntimeState>;
}

export interface RuntimeProbeClientPort {
  collectFacts(input?: { connectedAccountIds?: string[] }): Promise<Record<string, unknown>>;
}

export class AccountRuntimeReconciler implements AccountRuntimeReconcilerPort {
  constructor(private readonly options: {
    workspace?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {}) {}

  async reconcile(accountId: string): Promise<AccountRuntimeState> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new Error("QQ 账号 ID 无效。");
    const workspace = this.options.workspace ?? getWorkspaceDir();
    const registry = desiredAccountState(workspace, accountId);
    const desiredState = registry.desiredState;
    if (!registry.readable) {
      const state: AccountRuntimeState = {
        schemaVersion: 1,
        accountId,
        desiredState: "running",
        observedState: "unknown",
        reconcileRequired: true,
        lastError: "ACCOUNT_REGISTRY_UNREADABLE：账号注册库不可读；未生成停止或删除计划。",
        updatedAt: new Date().toISOString()
      };
      await persistRuntimeState(workspace, state);
      return state;
    }
    if (!await launcherReconcilerConfigured(workspace)) {
      const state: AccountRuntimeState = {
        schemaVersion: 1,
        accountId,
        desiredState,
        observedState: "unknown",
        reconcileRequired: true,
        lastError: "账号运行时服务未启动；请执行 ./sunabot.sh restart。",
        updatedAt: new Date().toISOString()
      };
      await persistRuntimeState(workspace, state);
      return state;
    }
    const requestId = crypto.randomUUID();
    const root = path.join(workspace, "runtime/account-reconciler");
    const requestPath = path.join(root, "requests", `${requestId}.json`);
    const resultPath = path.join(root, "results", `${requestId}.json`);
    await atomicJson(requestPath, {
      schemaVersion: 1,
      kind: "account-reconcile",
      requestId,
      accountId,
      desiredState,
      requestedAt: new Date().toISOString()
    });
    const deadline = Date.now() + (this.options.timeoutMs ?? 130_000);
    try {
      while (Date.now() < deadline) {
        try {
          const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as {
            schemaVersion?: number;
            requestId?: string;
            accountId?: string;
            state?: AccountRuntimeState;
          };
          if (result.schemaVersion !== 1 || result.requestId !== requestId || result.accountId !== accountId) {
            throw new Error("账号调和结果与请求不匹配。");
          }
          return validateState(result.state, accountId);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(this.options.pollIntervalMs ?? 100);
      }
      const state: AccountRuntimeState = {
        schemaVersion: 1,
        accountId,
        desiredState,
        observedState: "unknown",
        reconcileRequired: true,
        lastError: "账号运行时调和超时；请执行 ./sunabot.sh doctor。",
        updatedAt: new Date().toISOString()
      };
      await persistRuntimeState(workspace, state);
      return state;
    } finally {
      await Promise.all([
        fs.rm(requestPath, { force: true }),
        fs.rm(resultPath, { force: true })
      ]);
    }
  }
}

export class RuntimeProbeClient implements RuntimeProbeClientPort {
  constructor(private readonly options: {
    workspace?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {}) {}

  async collectFacts(input: { connectedAccountIds?: string[] } = {}): Promise<Record<string, unknown>> {
    const workspace = this.options.workspace ?? getWorkspaceDir();
    if (!await launcherReconcilerConfigured(workspace)) {
      throw new Error("Host runtime probe 服务未启动；请执行 ./sunabot.sh restart。");
    }
    const requestId = crypto.randomUUID();
    const root = path.join(workspace, "runtime/account-reconciler");
    const requestPath = path.join(root, "requests", `${requestId}.json`);
    const resultPath = path.join(root, "results", `${requestId}.json`);
    await atomicJson(requestPath, {
      schemaVersion: 1,
      kind: "runtime-probe",
      requestId,
      connectedAccountIds: (input.connectedAccountIds ?? []).filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value)),
      requestedAt: new Date().toISOString()
    });
    const deadline = Date.now() + (this.options.timeoutMs ?? 15_000);
    try {
      while (Date.now() < deadline) {
        try {
          const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as {
            schemaVersion?: number;
            kind?: string;
            requestId?: string;
            facts?: Record<string, unknown>;
            error?: string;
          };
          if (result.schemaVersion !== 1 || result.kind !== "runtime-probe" || result.requestId !== requestId) {
            throw new Error("Host runtime probe 结果与请求不匹配。");
          }
          if (result.error) throw new Error(result.error);
          if (!result.facts || typeof result.facts !== "object" || Array.isArray(result.facts)) {
            throw new Error("Host runtime probe 结果无效。");
          }
          return result.facts;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(this.options.pollIntervalMs ?? 50);
      }
      throw new Error("Host runtime probe 超时；请执行 ./sunabot.sh doctor。");
    } finally {
      await Promise.all([
        fs.rm(requestPath, { force: true }),
        fs.rm(resultPath, { force: true })
      ]);
    }
  }
}

async function persistRuntimeState(workspace: string, state: AccountRuntimeState) {
  await atomicJson(path.join(
    workspace,
    "runtime/napcat/accounts",
    state.accountId,
    "runtime-state.json"
  ), state);
}

function validateState(value: AccountRuntimeState | undefined, accountId: string) {
  if (
    value?.schemaVersion !== 1
    || value.accountId !== accountId
    || !["running", "stopped"].includes(value.desiredState)
    || !["running", "stopped", "missing", "unknown"].includes(value.observedState)
    || typeof value.reconcileRequired !== "boolean"
    || typeof value.updatedAt !== "string"
  ) {
    throw new Error("账号调和状态无效。");
  }
  return value;
}

async function atomicJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launcherReconcilerConfigured(workspace: string) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(workspace, "runtime/launcher-state.json"), "utf8"));
    return Number.isSafeInteger(state?.reconciler?.pid) && state.reconciler.pid > 0;
  } catch {
    return false;
  }
}

function desiredAccountState(workspace: string, accountId: string): {
  readable: boolean;
  desiredState: "running" | "stopped";
} {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"), { readOnly: true });
    const row = database.prepare(`
      SELECT aa.enabled AS account_enabled, a.enabled AS agent_enabled
      FROM agent_accounts aa
      JOIN agents a ON a.id = aa.agent_id
      WHERE aa.id = ?
    `).get(accountId) as { account_enabled?: number; agent_enabled?: number } | undefined;
    return {
      readable: true,
      desiredState: row?.account_enabled === 1 && row.agent_enabled === 1 ? "running" : "stopped"
    };
  } catch {
    return { readable: false, desiredState: "running" };
  } finally {
    database?.close();
  }
}
