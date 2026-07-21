import { readonly, shallowRef } from "vue";
import type { SunaTool, ToolExecutionMode } from "../types";
import { apiRequest } from "./useAdminApi";

export function useToolCatalog() {
  const tools = shallowRef<SunaTool[]>([]);
  const loading = shallowRef(false);
  const loaded = shallowRef(false);
  const error = shallowRef("");
  let requestId = 0;

  async function load(force = false) {
    if (loaded.value && !force) return;
    const activeRequest = ++requestId;
    loading.value = true;
    error.value = "";
    try {
      const payload = await apiRequest<{ tools?: unknown }>("/api/tools");
      if (!Array.isArray(payload.tools)) throw new Error("工具目录格式无效");
      const next = payload.tools.map(normalizeTool).filter((tool): tool is SunaTool => Boolean(tool));
      if (activeRequest !== requestId) return;
      tools.value = next;
      loaded.value = true;
    } catch (caught) {
      if (activeRequest === requestId) {
        error.value = caught instanceof Error ? caught.message : "工具目录读取失败";
      }
    } finally {
      if (activeRequest === requestId) loading.value = false;
    }
  }

  return {
    tools: readonly(tools),
    loading: readonly(loading),
    loaded: readonly(loaded),
    error: readonly(error),
    load
  };
}

function normalizeTool(value: unknown): SunaTool | null {
  if (!isRecord(value)) return null;
  const name = String(value.name ?? "").trim();
  if (!name) return null;
  const summary = stringValue(value.summary) || stringValue(value.description);
  const defaultDescription = stringValue(value.defaultDescription)
    || stringValue(value.promptDescription)
    || stringValue(value.description)
    || summary;
  const description = stringValue(value.description) || defaultDescription;
  const enabled = booleanValue(value.enabled)
    ?? booleanValue(value.inheritedEnabled)
    ?? true;
  const configuredEnabled = value.configuredEnabled === null
    ? null
    : booleanValue(value.configuredEnabled) ?? enabled;
  const parameters = Array.isArray(value.parameters) || isRecord(value.parameters)
    ? value.parameters
    : undefined;
  return {
    name,
    title: stringValue(value.title) || name,
    summary,
    execution: executionMode(value.execution) ?? defaultExecution(name),
    configuredEnabled,
    ...(typeof value.inheritedEnabled === "boolean" ? { inheritedEnabled: value.inheritedEnabled } : {}),
    ...(typeof value.promptEnabled === "boolean" ? { promptEnabled: value.promptEnabled } : {}),
    available: booleanValue(value.available) ?? true,
    enabled,
    ...(typeof value.effectiveEnabled === "boolean" ? { effectiveEnabled: value.effectiveEnabled } : {}),
    ...(typeof value.configurable === "boolean" ? { configurable: value.configurable } : {}),
    availabilityReason: stringValue(value.availabilityReason) || stringValue(value.unavailableReason),
    unavailableReason: stringValue(value.unavailableReason),
    ...(unavailabilityKind(value.unavailabilityKind) ? { unavailabilityKind: unavailabilityKind(value.unavailabilityKind) } : {}),
    accessLabel: stringValue(value.accessLabel),
    accessDescription: stringValue(value.accessDescription),
    ...(executionBackend(value.executionBackend) ? { executionBackend: executionBackend(value.executionBackend) } : {}),
    ...(bashEnvironments(value.bashEnvironments) ? { bashEnvironments: bashEnvironments(value.bashEnvironments) } : {}),
    runtimeReasonCode: stringValue(value.runtimeReasonCode),
    defaultDescription,
    promptDescription: stringValue(value.promptDescription),
    description,
    descriptionSource: stringValue(value.descriptionSource),
    ...(parameters ? { parameters } : {}),
    ...(typeof value.strict === "boolean" ? { strict: value.strict } : {})
  };
}

function defaultExecution(name: string): ToolExecutionMode {
  if (name === "codex") return "deferred";
  return "inline";
}

function executionMode(value: unknown): ToolExecutionMode | undefined {
  return value === "inline" || value === "deferred" ? value : undefined;
}

function executionBackend(value: unknown): "native" | "docker" | undefined {
  return value === "native" || value === "docker" ? value : undefined;
}

function bashEnvironments(value: unknown): SunaTool["bashEnvironments"] | undefined {
  if (!isRecord(value) || !isRecord(value.native) || !isRecord(value.docker)) return undefined;
  const nativeAvailable = booleanValue(value.native.available);
  const dockerStarted = booleanValue(value.docker.started);
  if (nativeAvailable === undefined || dockerStarted === undefined) return undefined;
  return {
    native: {
      available: nativeAvailable,
      ...(stringValue(value.native.reasonCode) ? { reasonCode: stringValue(value.native.reasonCode) } : {})
    },
    docker: {
      started: dockerStarted,
      ...(stringValue(value.docker.reasonCode) ? { reasonCode: stringValue(value.docker.reasonCode) } : {})
    }
  };
}

function unavailabilityKind(value: unknown): "runtime" | "session" | undefined {
  return value === "runtime" || value === "session" ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
