import { ServiceError } from "../../../packages/contracts/errors/serviceError.js";
import type { MemorySource, MemorySourceId, SourceDefinition } from "../types.js";
import { normalizeText } from "../domain/normalizers.js";

export function badRequest(code: string, message: string, field?: string): never {
  throw new ServiceError(400, code, message, field);
}

export const sourceDefinitions: SourceDefinition[] = [
  {
    id: "working",
    title: "工作记忆",
    fileName: "WORKING_MEMORY.md",
    legacyFileName: "WORKING_MEMORY.jsonl",
    editable: true,
    field: "fact",
    fields: ["fact", "text", "content", "summary", "memory"],
    idPrefix: "mem"
  },
  {
    id: "long_term",
    title: "长期记忆",
    fileName: "sunabot.sqlite#memory/long-term",
    legacyFileName: "LONG_TERM_MEMORY.jsonl",
    editable: true,
    field: "fact",
    fields: ["fact", "text", "content", "summary", "memory"],
    idPrefix: "longmem"
  },
  {
    id: "user_profile",
    title: "用户画像",
    fileName: "sunabot.sqlite#memory/user-profile",
    legacyFileName: "USER_PROFILE.jsonl",
    editable: true,
    field: "fact",
    fields: ["fact", "value", "text", "content", "summary", "memory"],
    idPrefix: "profile"
  },
];

export function toPublicSource(source: SourceDefinition): MemorySource {
  return {
    id: source.id,
    title: source.title,
    fileName: source.fileName,
    editable: source.editable
  };
}

export function selectSources(sourceInput: unknown) {
  const sourceText = normalizeText(sourceInput);
  const sourceId = normalizeSourceId(sourceInput);
  if (sourceText && sourceText !== "all" && !sourceId) {
    badRequest("MEMORY_SOURCE_INVALID", "记忆来源无效。", "source");
  }
  if (!sourceId) return sourceDefinitions;
  return [sourceById(sourceId)];
}

export function editableSource(sourceInput: unknown) {
  const sourceText = normalizeText(sourceInput);
  const sourceId = normalizeSourceId(sourceInput);
  if (sourceText && (!sourceId || sourceText === "all")) {
    badRequest("MEMORY_SOURCE_INVALID", "记忆来源无效。", "source");
  }
  const source = sourceById(sourceId ?? "working");
  if (!source.editable) badRequest("MEMORY_SOURCE_READ_ONLY", "该记忆来源不可编辑。", "source");
  return source;
}

export function sourceById(sourceId: MemorySourceId) {
  const source = sourceDefinitions.find((item) => item.id === sourceId);
  if (!source) throw new Error("记忆来源无效。");
  return source;
}

export function normalizeSourceId(value: unknown): MemorySourceId | undefined {
  const text = normalizeText(value);
  if (!text || text === "all") return undefined;
  return sourceDefinitions.some((source) => source.id === text) ? text as MemorySourceId : undefined;
}
