import { AdminApiError } from "./errors.js";

export type ConfigDoctorPatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
};

const MAX_OPERATIONS = 64;
const MAX_POINTER_DEPTH = 12;
const MAX_VALUE_BYTES = 32_768;
const FORBIDDEN_POINTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const RULE_REPAIRABLE_PATHS = new Set([
  "/schemaVersion",
  "/broadcastStorm/enabled",
  "/broadcastStorm/windowMinutes",
  "/broadcastStorm/replyThreshold",
  "/broadcastStorm/cooldownMinutes",
  "/normalReply/maxRetries",
  "/bot/pokeOnNoReply",
  "/bot/quoteGroupReplies",
  "/bot/contextMessageLimit",
  "/bot/memory/reasoningEffort",
  "/bot/memory/messageThreshold",
  "/bot/memory/workingMemoryMaxEntries",
  "/bot/orchestrator/enabled",
  "/bot/orchestrator/groupThreadModel",
  "/bot/orchestrator/reasoningEffort",
  "/bot/orchestrator/messageThreshold",
  "/bot/orchestrator/recentMessageWindowMs",
  "/bot/tools/maxCalls",
  "/bot/tools/websearch/maxResults",
  "/bot/tools/codex/timeoutMs",
  "/bot/tools/generateImg/provider",
  "/bot/tools/generateImg/size",
  "/bot/tools/generateImg/resolution",
  "/bot/tools/generateImg/quality",
  "/onebot/quoteGroupReplies"
]);

const AI_REPAIRABLE_PATHS = new Set([...RULE_REPAIRABLE_PATHS].filter((path) => (
  path !== "/schemaVersion" && path !== "/onebot/quoteGroupReplies"
)));
const BOOLEAN_REPAIR_PATHS = new Set([
  "/broadcastStorm/enabled",
  "/bot/pokeOnNoReply",
  "/bot/quoteGroupReplies",
  "/bot/orchestrator/enabled",
  "/onebot/quoteGroupReplies"
]);
const NUMBER_REPAIR_PATHS = new Set([
  "/broadcastStorm/windowMinutes",
  "/broadcastStorm/replyThreshold",
  "/broadcastStorm/cooldownMinutes",
  "/normalReply/maxRetries",
  "/bot/contextMessageLimit",
  "/bot/memory/messageThreshold",
  "/bot/memory/workingMemoryMaxEntries",
  "/bot/orchestrator/messageThreshold",
  "/bot/orchestrator/recentMessageWindowMs",
  "/bot/tools/maxCalls",
  "/bot/tools/websearch/maxResults",
  "/bot/tools/codex/timeoutMs"
]);
const STRING_REPAIR_PATHS = new Set([
  "/bot/memory/reasoningEffort",
  "/bot/orchestrator/groupThreadModel",
  "/bot/orchestrator/reasoningEffort",
  "/bot/tools/generateImg/provider",
  "/bot/tools/generateImg/size",
  "/bot/tools/generateImg/resolution",
  "/bot/tools/generateImg/quality"
]);

const RETIRED_PATHS = new Set([
  "/persona/memoryLimit",
  "/bot/tools/websearch/model",
  "/bot/tools/websearch/codexExecutable"
]);

const IGNORED_NORMALIZATION_PATHS = [
  /^\/providers\/items\/\d+\/(modelSource|multimodal|reasoningEffort)$/
];

export function diffConfigDocuments(
  before: unknown,
  after: unknown,
  options: { ignoreNormalizationArtifacts?: boolean } = {}
) {
  const operations: ConfigDoctorPatchOperation[] = [];
  walkDiff(before, true, after, true, "", operations);
  return options.ignoreNormalizationArtifacts === false
    ? operations
    : operations.filter((operation) => !IGNORED_NORMALIZATION_PATHS.some((pattern) => pattern.test(operation.path)));
}

export function isRuleRepairableOperation(operation: ConfigDoctorPatchOperation) {
  if (operation.op === "remove") return RETIRED_PATHS.has(operation.path);
  if (!RULE_REPAIRABLE_PATHS.has(operation.path)) return false;
  if (operation.path === "/schemaVersion") return operation.value === 1;
  if (BOOLEAN_REPAIR_PATHS.has(operation.path)) return typeof operation.value === "boolean";
  if (NUMBER_REPAIR_PATHS.has(operation.path)) return Number.isSafeInteger(operation.value);
  if (STRING_REPAIR_PATHS.has(operation.path)) return typeof operation.value === "string";
  return false;
}

export function isAiRepairableOperation(operation: ConfigDoctorPatchOperation) {
  return operation.op !== "remove" && isAiRepairablePath(operation.path);
}

export function isAiRepairablePath(path: string) {
  return AI_REPAIRABLE_PATHS.has(path);
}

export function operationRisk(operation: ConfigDoctorPatchOperation): "low" | "medium" {
  if (operation.op === "add" || operation.path === "/schemaVersion" || operation.op === "remove") return "low";
  return "medium";
}

export function applyConfigDoctorOperations(document: unknown, operations: readonly ConfigDoctorPatchOperation[]) {
  assertOperations(operations);
  const candidate = structuredClone(document) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw invalidPatch("配置文档必须是 JSON 对象。");
  }
  for (const operation of operations) applyOperation(candidate as Record<string, unknown>, operation);
  return candidate;
}

export function parseAiOperations(
  value: unknown,
  allowedPaths: ReadonlySet<string>
): Array<ConfigDoctorPatchOperation & { reason: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidAiOutput("模型响应必须是 JSON 对象。");
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || !Array.isArray(record.operations)) {
    throw invalidAiOutput("模型响应缺少 summary 或 operations。");
  }
  if (record.operations.length > 16) throw invalidAiOutput("模型返回的修改数量过多。");
  const operations = record.operations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidAiOutput(`第 ${index + 1} 项修改无效。`);
    }
    const operation = item as Record<string, unknown>;
    if ((operation.op !== "add" && operation.op !== "replace") || typeof operation.path !== "string") {
      throw invalidAiOutput(`第 ${index + 1} 项修改操作无效。`);
    }
    if (typeof operation.valueJson !== "string" || operation.valueJson.length > 4_096) {
      throw invalidAiOutput(`第 ${index + 1} 项修改值无效。`);
    }
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(operation.valueJson);
    } catch {
      throw invalidAiOutput(`第 ${index + 1} 项修改值不是合法 JSON。`);
    }
    const parsed = {
      op: operation.op,
      path: operation.path,
      value: parsedValue,
      reason: typeof operation.reason === "string" ? operation.reason.slice(0, 240) : "智能诊断建议"
    } as ConfigDoctorPatchOperation & { reason: string };
    assertOperations([parsed]);
    if (!isAiRepairableOperation(parsed)) throw invalidAiOutput(`模型建议修改受保护字段：${parsed.path}。`);
    if (!allowedPaths.has(parsed.path)) throw invalidAiOutput(`模型建议修改非当前问题字段：${parsed.path}。`);
    return parsed;
  });
  const paths = new Set<string>();
  for (const operation of operations) {
    if (paths.has(operation.path)) throw invalidAiOutput(`模型重复修改字段：${operation.path}。`);
    paths.add(operation.path);
  }
  return operations;
}

function walkDiff(
  before: unknown,
  beforeExists: boolean,
  after: unknown,
  afterExists: boolean,
  pointer: string,
  output: ConfigDoctorPatchOperation[]
) {
  if (!afterExists) {
    if (pointer) output.push({ op: "remove", path: pointer });
    return;
  }
  if (!beforeExists) {
    if (isPlainObject(after)) {
      for (const [key, value] of Object.entries(after)) {
        walkDiff(undefined, false, value, true, `${pointer}/${escapePointer(key)}`, output);
      }
      return;
    }
    output.push({ op: "add", path: pointer, value: structuredClone(after) });
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      walkDiff(
        before[key],
        Object.hasOwn(before, key),
        after[key],
        Object.hasOwn(after, key),
        `${pointer}/${escapePointer(key)}`,
        output
      );
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let index = 0; index < after.length; index += 1) {
      walkDiff(before[index], true, after[index], true, `${pointer}/${index}`, output);
    }
    return;
  }
  if (!deepEqual(before, after)) {
    output.push({ op: "replace", path: pointer, value: structuredClone(after) });
  }
}

function applyOperation(root: Record<string, unknown>, operation: ConfigDoctorPatchOperation) {
  const segments = pointerSegments(operation.path);
  let parent: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const current = parent[segment];
    if (current == null && operation.op === "add") {
      const next: Record<string, unknown> = {};
      parent[segment] = next;
      parent = next;
      continue;
    }
    if (!isPlainObject(current)) throw invalidPatch(`修改路径不存在：${operation.path}。`);
    parent = current;
  }
  const key = segments.at(-1)!;
  if (operation.op === "remove") {
    if (!Object.hasOwn(parent, key)) throw invalidPatch(`删除路径不存在：${operation.path}。`);
    delete parent[key];
    return;
  }
  if (operation.op === "replace" && !Object.hasOwn(parent, key)) {
    throw invalidPatch(`替换路径不存在：${operation.path}。`);
  }
  parent[key] = structuredClone(operation.value);
}

function assertOperations(operations: readonly ConfigDoctorPatchOperation[]) {
  if (operations.length > MAX_OPERATIONS) throw invalidPatch("配置修复项过多。");
  for (const operation of operations) {
    if (operation.op !== "add" && operation.op !== "replace" && operation.op !== "remove") {
      throw invalidPatch("配置修复操作无效。");
    }
    const segments = pointerSegments(operation.path);
    if (!segments.length || segments.length > MAX_POINTER_DEPTH) throw invalidPatch(`修改路径无效：${operation.path}。`);
    if (operation.op !== "remove") {
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(operation.value), "utf8");
      } catch {
        throw invalidPatch(`修改值无法序列化：${operation.path}。`);
      }
      if (size > MAX_VALUE_BYTES) throw invalidPatch(`修改值过大：${operation.path}。`);
    }
  }
}

function pointerSegments(pointer: string) {
  if (!pointer.startsWith("/") || pointer === "/") throw invalidPatch(`JSON Pointer 无效：${pointer}。`);
  const segments = pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((segment) => !segment || FORBIDDEN_POINTER_SEGMENTS.has(segment))) {
    throw invalidPatch(`JSON Pointer 包含受保护字段：${pointer}。`);
  }
  return segments;
}

function escapePointer(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidPatch(message: string) {
  return new AdminApiError(400, "CONFIG_DOCTOR_PATCH_INVALID", message);
}

function invalidAiOutput(message: string) {
  return new AdminApiError(422, "CONFIG_DOCTOR_AI_OUTPUT_INVALID", message);
}
