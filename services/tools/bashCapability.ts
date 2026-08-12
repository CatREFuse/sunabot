import path from "node:path";
import { resolveAgentBashEnvironment } from "../agents/public.js";
import {
  ensureWorkspaceBashIsolation,
  type WorkspaceBashSandboxOptions
} from "./bashSandbox.js";

const DEFAULT_FAILURE_RETRY_MS = 3_000;

export interface WorkspaceBashCapabilityProbeOptions {
  platform?: NodeJS.Platform;
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
  | "BASH_WORKBENCH_UNAVAILABLE";

export interface RuntimeToolCapabilityContext {
  workspacePath: string;
  workspaceBashAuditAvailable: boolean;
}

export type RuntimeToolCapabilityResolver = (
  context?: RuntimeToolCapabilityContext
) => Promise<RuntimeToolCapabilities>;

export type RuntimeToolCapabilitySnapshotResolver = () => Promise<RuntimeToolCapabilities>;

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
      ? normalizeWorkspaceBashCapability(workspaceBash.value)
      : unavailableWorkspaceBashCapability();
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
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_FAILURE_RETRY_MS);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; result: Promise<WorkspaceBashCapabilityProbeResult> }>();

  return async (workspacePath: string) => {
    const workspace = path.resolve(workspacePath);
    const cacheKey = `${platform}\0${workspace}`;
    const cached = cache.get(cacheKey);
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) return cached.result;

    const result = resolveAgentBashEnvironment(workspace).then(
      async (bashEnvironment) => {
        return ensureWorkspaceBashIsolation("native", bashEnvironment.workbenchRoot, {
          PATH: process.env.PATH || "/usr/bin:/bin"
        }, {
          ...options.sandbox,
          platform,
          readOnlyMounts: bashEnvironment.readOnlyMounts
        }).then(
          () => ({ available: true }),
          () => unavailableWorkspaceBashCapability()
        );
      },
      () => ({ available: false, reason: "BASH_WORKBENCH_UNAVAILABLE" as const })
    );
    const entry = { expiresAt: currentTime + ttlMs, result };
    cache.set(cacheKey, entry);
    void result.then((capability) => {
      if (cache.get(cacheKey) !== entry) return;
      entry.expiresAt = capability.available
        ? Number.POSITIVE_INFINITY
        : now() + ttlMs;
    });
    return result;
  };
}

function normalizeWorkspaceBashCapability(
  result: boolean | WorkspaceBashCapabilityProbeResult
): WorkspaceBashCapabilityProbeResult {
  if (typeof result === "boolean") {
    return result ? { available: true } : unavailableWorkspaceBashCapability();
  }
  return result.available
    ? { available: true }
    : {
        available: false,
        reason: result.reason ?? unavailableWorkspaceBashCapability().reason
      };
}

function unavailableWorkspaceBashCapability(): WorkspaceBashCapabilityProbeResult {
  return {
    available: false,
    reason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
  };
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
