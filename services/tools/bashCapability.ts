import path from "node:path";
import { resolveAgentWorkbench } from "../agents/public.js";
import type { BashExecutionBackend } from "./bashAudit.js";
import {
  ensureWorkspaceBashIsolation,
  type WorkspaceBashSandboxOptions
} from "./bashSandbox.js";

const DEFAULT_CAPABILITY_TTL_MS = 30_000;

export interface WorkspaceBashCapabilityProbeOptions {
  platform?: NodeJS.Platform;
  backend?: BashExecutionBackend;
  runtimeMode?: string;
  sandbox?: WorkspaceBashSandboxOptions;
  ttlMs?: number;
  now?: () => number;
}

export interface RuntimeToolCapabilities {
  workspaceBash: boolean;
  codex: boolean;
}

export interface RuntimeToolCapabilityContext {
  workspacePath: string;
  workspaceBashBackend: BashExecutionBackend;
  workspaceBashAuditAvailable: boolean;
}

export type RuntimeToolCapabilityResolver = (
  context?: RuntimeToolCapabilityContext
) => Promise<RuntimeToolCapabilities>;

export type RuntimeToolCapabilitySnapshotResolver = () => Promise<RuntimeToolCapabilities>;

export interface RuntimeToolCapabilityResolverOptions {
  getCodexStatus: () => Promise<{ installed: boolean; authenticated: boolean }>;
  getWorkspaceBashCapability: (context: RuntimeToolCapabilityContext) => Promise<boolean>;
}

export function createRuntimeToolCapabilityResolver(
  options: RuntimeToolCapabilityResolverOptions
): RuntimeToolCapabilityResolver {
  return async (context) => {
    const workspaceBashCapability = context?.workspaceBashAuditAvailable === true
      ? options.getWorkspaceBashCapability(context)
      : Promise.resolve(false);
    const [codex, workspaceBash] = await Promise.allSettled([
      options.getCodexStatus(),
      workspaceBashCapability
    ]);
    return {
      codex: codex.status === "fulfilled" && codex.value.installed && codex.value.authenticated,
      workspaceBash: workspaceBash.status === "fulfilled" && workspaceBash.value === true
    };
  };
}

export function createWorkspaceBashCapabilityProbe(
  options: WorkspaceBashCapabilityProbeOptions = {}
) {
  const platform = options.platform ?? process.platform;
  const backend = options.backend ?? "native";
  const runtimeMode = options.runtimeMode ?? process.env.SUNABOT_RUNTIME_MODE ?? "native";
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_CAPABILITY_TTL_MS);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

  return async (workspacePath: string) => {
    const workspace = path.resolve(workspacePath);
    const cacheKey = `${backend}\0${runtimeMode}\0${workspace}`;
    const cached = cache.get(cacheKey);
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) return cached.result;

    const result = resolveAgentWorkbench(workspace)
      .then((workbench) => ensureWorkspaceBashIsolation(backend, workbench, {
        PATH: process.env.PATH || "/usr/bin:/bin"
      }, {
        ...options.sandbox,
        platform,
        runtimeMode
      }))
      .then(() => true, () => false);
    cache.set(cacheKey, { expiresAt: currentTime + ttlMs, result });
    return result;
  };
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
