import { shallowReadonly, shallowRef } from "vue";
import { apiRequest } from "./useAdminApi";
import type { ModelCatalogItem, ReasoningEffort } from "../types";

const fallbackModels: ModelCatalogItem[] = [
  model("gpt-5.5", "5.5", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.6-sol", "5.6 Sol", "low", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-terra", "5.6 Terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-luna", "5.6 Luna", "medium", ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.4", "5.4", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.4-mini", "5.4 Mini", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.3-codex-spark", "5.3 Codex Spark", "high", ["low", "medium", "high", "xhigh"])
];

const models = shallowRef<ModelCatalogItem[]>(fallbackModels);
const loading = shallowRef(false);
const error = shallowRef("");
let loaded = false;

async function load() {
  if (loaded || loading.value) return;
  loading.value = true;
  try {
    const payload = await apiRequest<unknown>("/api/models");
    const raw = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
    const normalized = raw.map(normalizeModel).filter((entry): entry is ModelCatalogItem => entry != null);
    if (normalized.length) models.value = normalized;
    loaded = true;
    error.value = "";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "模型目录读取失败";
  } finally {
    loading.value = false;
  }
}

function normalizeModel(value: unknown): ModelCatalogItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return null;
  const efforts = Array.isArray(value.reasoningEfforts)
    ? value.reasoningEfforts
    : Array.isArray(value.supportedReasoningEfforts)
      ? value.supportedReasoningEfforts
      : [];
  const supported = efforts.filter(isReasoningEffort);
  const fallback = isReasoningEffort(value.defaultReasoningEffort) ? value.defaultReasoningEffort : supported[0] ?? "medium";
  return model(value.id, value.label, fallback, supported.length ? supported : [fallback]);
}

function model(id: string, label: string, defaultReasoningEffort: ReasoningEffort, supportedReasoningEfforts: ReasoningEffort[]): ModelCatalogItem {
  return { id, label, defaultReasoningEffort, supportedReasoningEfforts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(value));
}

export function useModelCatalog() {
  return { models: shallowReadonly(models), loading: shallowReadonly(loading), error: shallowReadonly(error), load };
}
