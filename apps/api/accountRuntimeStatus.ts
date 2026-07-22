import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../packages/platform/projectPaths.js";
import type { AccountRuntimeStatusSnapshot } from "../../services/agents/agentRuntimeManager.js";

export function readAccountRuntimeStatus(accountId: string): AccountRuntimeStatusSnapshot {
  const accountRoot = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, accountId);
  const configured = existsSync(path.join(accountRoot, "config-full", "webui.json"));
  try {
    const value = JSON.parse(readFileSync(path.join(accountRoot, "runtime-state.json"), "utf8"));
    return value?.schemaVersion === 1 ? { ...value, configured } : { configured };
  } catch {
    return { configured };
  }
}
