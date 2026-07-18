import type { SunaTool, ToolExecutionMode, ToolParameterSummary } from "../types";

const toolIcons: Record<string, string> = {
  memory_recall: "bx-brain",
  assistant_text: "bx-message-rounded-dots",
  websearch: "bx-globe",
  generate_img: "bx-image-add",
  selfie: "bx-camera",
  workspace_bash: "bx-terminal",
  codex: "bx-code-alt"
};

const executionLabels: Record<ToolExecutionMode, string> = {
  inline: "同步",
  deferred: "异步"
};

export function toolIcon(name: string) {
  return toolIcons[name] ?? "bx-wrench";
}

export function toolExecutionLabel(execution: ToolExecutionMode | undefined) {
  return execution ? executionLabels[execution] : "工具";
}

export function toolAvailabilityPresentation(tool: SunaTool) {
  if (tool.available !== false) return { kind: "ready" as const, label: "", reason: "" };
  if (tool.unavailabilityKind === "session") {
    return {
      kind: "session" as const,
      label: tool.accessLabel || "限定会话",
      reason: tool.accessDescription || tool.availabilityReason || tool.unavailableReason || "当前会话不可用。"
    };
  }
  return {
    kind: "runtime" as const,
    label: "运行环境异常",
    reason: tool.availabilityReason || tool.unavailableReason || "当前工具运行异常。"
  };
}

export function toolParameterRows(parameters: SunaTool["parameters"]): ToolParameterSummary[] {
  if (Array.isArray(parameters)) {
    return parameters
      .filter(isRecord)
      .map((parameter) => ({
        name: String(parameter.name ?? ""),
        type: valueType(parameter.type),
        required: parameter.required === true,
        description: String(parameter.description ?? "")
      }))
      .filter((parameter) => parameter.name);
  }
  if (!isRecord(parameters) || !isRecord(parameters.properties)) return [];
  const required = new Set(Array.isArray(parameters.required)
    ? parameters.required.map((item) => String(item))
    : []);
  return Object.entries(parameters.properties).map(([name, definition]) => {
    const value = isRecord(definition) ? definition : {};
    return {
      name,
      type: valueType(value.type, value.enum),
      required: required.has(name),
      description: String(value.description ?? "")
    };
  });
}

function valueType(type: unknown, enumValues?: unknown) {
  const values = Array.isArray(type) ? type.map(String) : typeof type === "string" ? [type] : [];
  if (Array.isArray(enumValues) && enumValues.length) {
    const enumLabel = enumValues.map((item) => item === null ? "null" : String(item)).join(" | ");
    return values.length ? `${values.join(" / ")} · ${enumLabel}` : enumLabel;
  }
  return values.join(" / ") || "任意";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
