import path from "node:path";
import { resolveAgentBashEnvironment } from "../agents/public.js";
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
  workspaceBashReason?: WorkspaceBashUnavailableReason;
  codex: boolean;
}

export interface WorkspaceBashCapabilityProbeResult {
  available: boolean;
  reason?: WorkspaceBashUnavailableReason;
}

export type WorkspaceBashUnavailableReason =
  | "BASH_AUDIT_UNAVAILABLE"
  | "BASH_NATIVE_ISOLATION_UNAVAILABLE"
  | "BASH_DOCKER_ISOLATION_UNAVAILABLE"
  | "BASH_WORKBENCH_UNAVAILABLE";

export interface RuntimeToolCapabilityContext {
  workspacePath: string;
  workspaceBashBackend: BashExecutionBackend;
  workspaceBashAuditAvailable: boolean;
}

export type RuntimeToolCapabilityResolver = (
  context?: RuntimeToolCapabilityContext
) => Promise<RuntimeToolCapabilities>;

export type RuntimeToolCapabilitySnapshotResolver = (
  backendOverride?: BashExecutionBackend | null
) => Promise<RuntimeToolCapabilities>;

export interface RuntimeToolCapabilityResolverOptions {
  getCodexStatus: () => Promise<{ installed: boolean; authenticated: boolean }>;
  getWorkspaceBashCapability: (
    context: RuntimeToolCapabilityContext
  ) => Promise<boolean | WorkspaceBashCapabilityProbeResult>;
}

export function createRuntimeToolCapabilityResolver(
  options: RuntimeToolCapabilityResolverOptions
): RuntimeToolCapabilityResolver {
  return async (context) => {
    const workspaceBashCapability = context?.workspaceBashAuditAvailable === true
      ? options.getWorkspaceBashCapability(context)
      : Promise.resolve({
          available: false,
          reason: "BASH_AUDIT_UNAVAILABLE" as const
        });
    const [codex, workspaceBash] = await Promise.allSettled([
      options.getCodexStatus(),
      workspaceBashCapability
    ]);
    const bashCapability = workspaceBash.status === "fulfilled"
      ? normalizeWorkspaceBashCapability(workspaceBash.value, context?.workspaceBashBackend)
      : unavailableWorkspaceBashCapability(context?.workspaceBashBackend);
    return {
      codex: codex.status === "fulfilled" && codex.value.installed && codex.value.authenticated,
      workspaceBash: bashCapability.available,
      ...(!bashCapability.available && bashCapability.reason ? {
        workspaceBashReason: bashCapability.reason
      } : {})
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
  const cache = new Map<string, { expiresAt: number; result: Promise<WorkspaceBashCapabilityProbeResult> }>();

  return async (workspacePath: string) => {
    const workspace = path.resolve(workspacePath);
    const cacheKey = `${backend}\0${runtimeMode}\0${workspace}`;
    const cached = cache.get(cacheKey);
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) return cached.result;

    const result = resolveAgentBashEnvironment(workspace, backend).then(
      (bashEnvironment) => ensureWorkspaceBashIsolation(backend, bashEnvironment.workbenchRoot, {
        PATH: process.env.PATH || "/usr/bin:/bin"
      }, {
        ...options.sandbox,
        platform,
        runtimeMode,
        readOnlyMounts: bashEnvironment.readOnlyMounts
      }).then(
        () => ({ available: true }),
        () => unavailableWorkspaceBashCapability(backend)
      ),
      () => ({ available: false, reason: "BASH_WORKBENCH_UNAVAILABLE" as const })
    );
    cache.set(cacheKey, { expiresAt: currentTime + ttlMs, result });
    return result;
  };
}

function normalizeWorkspaceBashCapability(
  result: boolean | WorkspaceBashCapabilityProbeResult,
  backend: BashExecutionBackend | undefined
): WorkspaceBashCapabilityProbeResult {
  if (typeof result === "boolean") {
    return result ? { available: true } : unavailableWorkspaceBashCapability(backend);
  }
  return result.available
    ? { available: true }
    : {
        available: false,
        reason: result.reason ?? unavailableWorkspaceBashCapability(backend).reason
      };
}

function unavailableWorkspaceBashCapability(
  backend: BashExecutionBackend | undefined
): WorkspaceBashCapabilityProbeResult {
  return {
    available: false,
    reason: backend === "native"
      ? "BASH_NATIVE_ISOLATION_UNAVAILABLE"
      : "BASH_DOCKER_ISOLATION_UNAVAILABLE"
  };
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
