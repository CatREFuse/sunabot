import type { ReasoningEffort } from "./public.js";

export interface ModelCatalogEntry {
  id: string;
  label: string;
  defaultReasoningEffort: ReasoningEffort;
  reasoningEfforts: ReasoningEffort[];
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
];

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  model("gpt-5.5", "5.5", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.6-sol", "5.6 Sol", "low", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-terra", "5.6 Terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-luna", "5.6 Luna", "medium", ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.4", "5.4", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.4-mini", "5.4 Mini", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.3-codex-spark", "5.3 Codex Spark", "high", ["low", "medium", "high", "xhigh"])
];

export const IMAGE_MODEL_CATALOG = [
  { id: "gpt-image-2", label: "GPT Image 2" }
] as const;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function getModelCatalogEntry(modelId: string) {
  return MODEL_CATALOG.find((entry) => entry.id === modelId.trim());
}

export function resolveModelReasoningEffort(
  modelId: string,
  requested: ReasoningEffort | undefined,
  customFallback: ReasoningEffort = "medium"
) {
  const entry = getModelCatalogEntry(modelId);
  if (!entry) {
    return {
      effort: requested ?? customFallback,
      adjusted: false,
      catalogEntry: undefined
    };
  }

  if (requested && entry.reasoningEfforts.includes(requested)) {
    return { effort: requested, adjusted: false, catalogEntry: entry };
  }

  return {
    effort: entry.defaultReasoningEffort,
    adjusted: requested != null && requested !== entry.defaultReasoningEffort,
    catalogEntry: entry
  };
}

function model(
  id: string,
  label: string,
  defaultReasoningEffort: ReasoningEffort,
  reasoningEfforts: ReasoningEffort[]
): ModelCatalogEntry {
  return { id, label, defaultReasoningEffort, reasoningEfforts };
}
