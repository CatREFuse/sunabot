import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { resolveProjectPath } from "../../packages/platform/projectPaths.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../packages/platform/systemTime.js";
import type { MemoryEntry, MemoryFactInput } from "./types.js";
import { recordMemoryOperation, type MemoryOperationActor } from "./operationAudit.js";

export const WORKING_MEMORY_FILE = "WORKING_MEMORY.md";
export const WORKING_MEMORY_MAX_BYTES = 64 * 1024;
export const WORKING_MEMORY_MAX_ITEM_CHARS = 4_000;

const LEGACY_DOCUMENT_HEADER = "# 工作记忆\n\n<!-- sunabot-workmemory:v1 -->";
const DOCUMENT_HEADER = "<!-- sunabot-workmemory:v2 -->";
const ITEM_MARKER = "<!-- sunabot-workmemory:item ";
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/u;

export interface WorkingMemoryConversationSource {
  conversationId: string;
  scope: string;
  title?: string;
}

export interface WorkingMemoryDocumentItem {
  id: string;
  content: string;
  recordedAt: string;
  timeZone: string;
  conversationId: string;
  conversationScope: string;
  conversationTitle: string;
  sourceKind: "model_merge" | "add_workmemory" | "admin" | "dream";
  batchId?: string;
  userId?: string;
  userIds?: string[];
  userName?: string;
  addressNames?: string[];
  occurredAt?: string;
  occurredEndAt?: string;
  eventType?: string;
  subjectKey?: string;
  eventKey?: string;
  causalChainKey?: string;
  sourceMemoryIds?: string[];
  memoryKind?: string;
  realityStatus?: string;
  factuality?: string;
  dreamRunId?: string;
  dreamDate?: string;
  dreamReviewedAt?: string;
}

export interface WorkingMemoryDocumentSnapshot {
  filePath: string;
  content: string;
  revision: string;
  items: WorkingMemoryDocumentItem[];
}

export async function ensureWorkingMemoryDocument(config: AppConfig) {
  const current = await readWorkingMemoryDocument(config);
  if (current.content) return current;
  const result = await replaceWorkingMemoryDocument(config, current.revision, []);
  return result.current;
}

export async function readWorkingMemoryDocument(config: AppConfig): Promise<WorkingMemoryDocumentSnapshot> {
  const filePath = await resolveWorkingMemoryPath(config);
  const content = await readOptionalRegularFile(filePath);
  if (!content) {
    return { filePath, content: "", revision: revision(""), items: [] };
  }
  assertDocumentSize(content);
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  const items = parseWorkingMemoryMarkdown(normalized);
  return { filePath, content: normalized, revision: revision(normalized), items };
}

export async function replaceWorkingMemoryDocument(
  config: AppConfig,
  expectedRevision: string,
  items: readonly WorkingMemoryDocumentItem[]
) {
  const normalizedItems = items.map(validateWorkingMemoryItem);
  const content = renderWorkingMemoryMarkdown(normalizedItems);
  assertDocumentSize(content);
  const parsed = parseWorkingMemoryMarkdown(content);
  if (JSON.stringify(parsed) !== JSON.stringify(normalizedItems)) {
    throw workingMemoryError("WORKING_MEMORY_DOCUMENT_INVALID", "Working memory document failed round-trip validation.");
  }

  const current = await readWorkingMemoryDocument(config);
  if (current.revision !== expectedRevision) return { status: "conflict" as const, current };
  if (current.content === content) return { status: "unchanged" as const, current: { ...current, items: parsed } };

  await assertWorkspaceDirectory(path.dirname(current.filePath));
  const temporary = path.join(
    path.dirname(current.filePath),
    `.${WORKING_MEMORY_FILE}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
  );
  const handle = await fs.open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(`${content}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const latest = await readWorkingMemoryDocument(config);
    if (latest.revision !== expectedRevision) {
      await fs.rm(temporary, { force: true });
      return { status: "conflict" as const, current: latest };
    }
    await assertReplaceTarget(current.filePath);
    await fs.rename(temporary, current.filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const updated = await readWorkingMemoryDocument(config);
  return { status: "updated" as const, current: updated };
}

export async function appendWorkingMemoryDocumentItem(
  config: AppConfig,
  contentInput: string,
  source: WorkingMemoryConversationSource,
  sourceKind: WorkingMemoryDocumentItem["sourceKind"] = "add_workmemory"
) {
  const content = normalizeContent(contentInput);
  const timeZone = systemModelTimeZone();
  const item: WorkingMemoryDocumentItem = {
    id: `working_${nanoid()}`,
    content,
    recordedAt: formatModelTimestamp(new Date(), timeZone),
    timeZone,
    conversationId: requiredLine(source.conversationId, "conversationId", 256),
    conversationScope: requiredLine(source.scope, "conversationScope", 64),
    conversationTitle: optionalLine(source.title, 500),
    sourceKind
  };
  let lastRevision = "";
  let lastCount = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readWorkingMemoryDocument(config);
    lastRevision = current.revision;
    lastCount = current.items.length;
    const result = await replaceWorkingMemoryDocument(config, current.revision, [...current.items, item]);
    if (result.status !== "conflict") {
      recordMemoryOperation(config, {
        source: "working",
        operation: "append",
        actor: workingMemoryActor(sourceKind),
        outcome: result.status === "unchanged" ? "unchanged" : "applied",
        recordIds: [item.id],
        conversationId: item.conversationId,
        conversationScope: item.conversationScope,
        beforeCount: current.items.length,
        afterCount: result.current.items.length,
        changedCount: result.status === "unchanged" ? 0 : 1,
        beforeRevision: current.revision,
        afterRevision: result.current.revision
      });
      return { item, revision: result.current.revision };
    }
  }
  recordMemoryOperation(config, {
    source: "working",
    operation: "append",
    actor: workingMemoryActor(sourceKind),
    outcome: "conflict",
    recordIds: [item.id],
    conversationId: item.conversationId,
    conversationScope: item.conversationScope,
    beforeCount: lastCount,
    afterCount: lastCount,
    changedCount: 0,
    beforeRevision: lastRevision,
    reasonCode: "revision_conflict"
  });
  throw workingMemoryError("WORKING_MEMORY_CONFLICT", "Working memory changed during add_workmemory.");
}

function workingMemoryActor(sourceKind: WorkingMemoryDocumentItem["sourceKind"]): MemoryOperationActor {
  if (sourceKind === "add_workmemory") return "model_tool";
  if (sourceKind === "admin") return "admin";
  return "memory_pipeline";
}

export function workingMemoryItemsFromFacts(
  facts: readonly MemoryFactInput[],
  previous: readonly WorkingMemoryDocumentItem[],
  metadata: Record<string, unknown>,
  allocateId: (fact: MemoryFactInput, index: number) => string,
  sourceKind: WorkingMemoryDocumentItem["sourceKind"] = "model_merge"
) {
  const byId = new Map(previous.map((item) => [item.id, item]));
  const conversationId = requiredLine(metadata.conversationId, "conversationId", 256);
  const conversationScope = requiredLine(metadata.conversationScope, "conversationScope", 64);
  const conversationTitle = optionalLine(metadata.conversationTitle, 500);
  const batchId = boundedOpaqueMetadata(metadata.batchId, 256);
  const timeZone = systemModelTimeZone();
  const recordedAt = formatModelTimestamp(new Date(), timeZone);
  const seen = new Set<string>();
  return facts.map((fact, index) => {
    const requestedId = optionalLine(fact.id, 128);
    const existing = requestedId ? byId.get(requestedId) : undefined;
    const id = existing?.id ?? allocateId(fact, index);
    if (!ITEM_ID_PATTERN.test(id) || seen.has(id)) {
      throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory item IDs must be unique and valid.");
    }
    seen.add(id);
    const content = normalizeContent(fact.fact);
    const semantic = existing?.content === content ? {
      content,
      userId: existing.userId,
      userIds: existing.userIds,
      userName: existing.userName,
      addressNames: existing.addressNames,
      occurredAt: existing.occurredAt,
      occurredEndAt: existing.occurredEndAt,
      eventType: existing.eventType,
      subjectKey: existing.subjectKey,
      eventKey: existing.eventKey,
      causalChainKey: existing.causalChainKey,
      sourceMemoryIds: existing.sourceMemoryIds,
      memoryKind: existing.memoryKind,
      realityStatus: existing.realityStatus,
      factuality: existing.factuality,
      dreamRunId: existing.dreamRunId,
      dreamDate: existing.dreamDate,
      dreamReviewedAt: existing.dreamReviewedAt
    } : {
      content,
      userId: optionalLine(fact.userId, 64),
      userIds: normalizedStringArray(fact.userIds, 64),
      userName: optionalLine(fact.userName, 200),
      addressNames: normalizedStringArray(fact.addressNames, 200),
      occurredAt: optionalTimestamp(fact.occurredAt ?? fact.time),
      occurredEndAt: optionalTimestamp(fact.occurredEndAt),
      eventType: optionalLine(fact.eventType, 100),
      subjectKey: optionalLine(fact.subjectKey, 200),
      eventKey: optionalLine(fact.eventKey, 256),
      causalChainKey: optionalLine(fact.causalChainKey, 256),
      sourceMemoryIds: normalizedStringArray(fact.sourceMemoryIds, 128),
      memoryKind: optionalLine(fact.memoryKind, 64),
      realityStatus: optionalLine(fact.realityStatus, 64),
      factuality: optionalLine(fact.factuality, 64),
      dreamRunId: optionalLine(fact.dreamRunId, 128),
      dreamDate: optionalLine(fact.dreamDate, 32),
      dreamReviewedAt: optionalTimestamp(fact.dreamReviewedAt)
    };
    const unchanged = existing != null && semanticWorkingMemoryFields(existing) === JSON.stringify(semantic);
    return validateWorkingMemoryItem({
      id,
      ...semantic,
      recordedAt: unchanged ? existing.recordedAt : recordedAt,
      timeZone: unchanged ? existing.timeZone : timeZone,
      conversationId: existing?.conversationId ?? conversationId,
      conversationScope: existing?.conversationScope ?? conversationScope,
      conversationTitle: existing?.conversationTitle ?? conversationTitle,
      sourceKind: existing?.sourceKind ?? sourceKind,
      batchId: existing?.batchId ?? batchId
    });
  });
}

function semanticWorkingMemoryFields(item: WorkingMemoryDocumentItem) {
  return JSON.stringify({
    content: item.content,
    userId: item.userId ?? "",
    userIds: item.userIds,
    userName: item.userName ?? "",
    addressNames: item.addressNames,
    occurredAt: item.occurredAt,
    occurredEndAt: item.occurredEndAt,
    eventType: item.eventType ?? "",
    subjectKey: item.subjectKey ?? "",
    eventKey: item.eventKey ?? "",
    causalChainKey: item.causalChainKey ?? "",
    sourceMemoryIds: item.sourceMemoryIds,
    memoryKind: item.memoryKind ?? "",
    realityStatus: item.realityStatus ?? "",
    factuality: item.factuality ?? "",
    dreamRunId: item.dreamRunId ?? "",
    dreamDate: item.dreamDate ?? "",
    dreamReviewedAt: item.dreamReviewedAt
  });
}

export function workingMemoryItemToEntry(item: WorkingMemoryDocumentItem): MemoryEntry {
  return {
    id: item.id,
    source: "working",
    sourceTitle: "工作记忆",
    fileName: WORKING_MEMORY_FILE,
    editable: true,
    key: item.id,
    value: item.content,
    text: item.content,
    field: "fact",
    time: item.recordedAt,
    observedAt: item.recordedAt,
    createdAt: item.recordedAt,
    updatedAt: item.recordedAt,
    recordedAt: item.recordedAt,
    timeZone: item.timeZone,
    conversationId: item.conversationId,
    conversationScope: item.conversationScope,
    conversationTitle: item.conversationTitle || undefined,
    sourceKind: item.sourceKind,
    batchId: item.batchId,
    userId: item.userId,
    userIds: item.userIds,
    userName: item.userName,
    addressNames: item.addressNames,
    addressName: item.addressNames?.[0],
    occurredAt: item.occurredAt,
    occurredEndAt: item.occurredEndAt,
    eventType: item.eventType,
    subjectKey: item.subjectKey,
    eventKey: item.eventKey,
    causalChainKey: item.causalChainKey,
    sourceMemoryIds: item.sourceMemoryIds,
    memoryKind: item.memoryKind,
    realityStatus: item.realityStatus,
    factuality: item.factuality,
    dreamRunId: item.dreamRunId,
    dreamDate: item.dreamDate,
    dreamReviewedAt: item.dreamReviewedAt
  };
}

export function renderWorkingMemoryMarkdown(items: readonly WorkingMemoryDocumentItem[]) {
  if (!items.length) return DOCUMENT_HEADER;
  return [
    DOCUMENT_HEADER,
    "",
    ...items.flatMap((item, index) => [
      `${ITEM_MARKER}${Buffer.from(JSON.stringify({
        ...item,
        content: undefined
      }), "utf8").toString("base64url")} -->`,
      item.content,
      ...(index === items.length - 1 ? [] : [""])
    ])
  ].join("\n");
}

export function parseWorkingMemoryMarkdown(content: string) {
  assertDocumentSize(content);
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  const legacy = normalized.startsWith(LEGACY_DOCUMENT_HEADER);
  const header = legacy ? LEGACY_DOCUMENT_HEADER : DOCUMENT_HEADER;
  if (!normalized.startsWith(header)) {
    throw workingMemoryError("WORKING_MEMORY_DOCUMENT_INVALID", "Working memory document header is invalid.");
  }
  const rest = normalized.slice(header.length);
  if (!rest.trim() || (legacy && rest === "\n\n当前没有工作记忆事项。")) return [];

  const markerPattern = /^<!-- sunabot-workmemory:item ([A-Za-z0-9_-]+) -->$/gmu;
  const matches = [...rest.matchAll(markerPattern)];
  if (!matches.length || rest.slice(0, matches[0]!.index).trim()) {
    throw workingMemoryError("WORKING_MEMORY_DOCUMENT_INVALID", "Working memory document contains unstructured content.");
  }
  const items = matches.map((match, index) => {
    const encoded = match[1]!;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? rest.length;
    const block = rest.slice(start, end).trim();
    let metadata: unknown;
    try {
      metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw workingMemoryError("WORKING_MEMORY_DOCUMENT_INVALID", "Working memory item metadata is invalid.");
    }
    const itemMetadata = validateWorkingMemoryItem({
      ...(metadata as Record<string, unknown>),
      content: "pending"
    });
    const visibleContent = legacy
      ? parseLegacyWorkingMemoryBlock(block, itemMetadata)
      : block;
    return validateWorkingMemoryItem({
      ...(metadata as Record<string, unknown>),
      content: visibleContent
    });
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw workingMemoryError("WORKING_MEMORY_DOCUMENT_INVALID", "Working memory item IDs are duplicated.");
  }
  return items;
}

function parseLegacyWorkingMemoryBlock(
  block: string,
  itemMetadata: WorkingMemoryDocumentItem
) {
  const prefix = [
    `## ${itemMetadata.id}`,
    "",
    `- 记录时间：${itemMetadata.recordedAt} [${itemMetadata.timeZone}]`,
    `- 会话来源：${itemMetadata.conversationId}（${itemMetadata.conversationScope}）`,
    `- 会话标题：${itemMetadata.conversationTitle || "未命名"}`,
    `- 来源类型：${itemMetadata.sourceKind}`,
    ""
  ].join("\n");
  if (!block.startsWith(prefix)) {
    throw workingMemoryError(
      "WORKING_MEMORY_DOCUMENT_INVALID",
      "Legacy working memory visible metadata does not match its host metadata."
    );
  }
  return block.slice(prefix.length).trim();
}

function validateWorkingMemoryItem(input: unknown): WorkingMemoryDocumentItem {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory item is invalid.");
  }
  const value = input as Record<string, unknown>;
  const id = requiredLine(value.id, "id", 128);
  if (!ITEM_ID_PATTERN.test(id)) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory item ID is invalid.");
  }
  const recordedAt = requiredLine(value.recordedAt, "recordedAt", 64);
  if (!OFFSET_TIMESTAMP_PATTERN.test(recordedAt) || !Number.isFinite(Date.parse(recordedAt))) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory recorded time must include a UTC offset.");
  }
  const timeZone = requiredLine(value.timeZone, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory time zone is invalid.");
  }
  const sourceKind = requiredLine(value.sourceKind, "sourceKind", 64);
  if (sourceKind !== "model_merge" && sourceKind !== "add_workmemory" &&
    sourceKind !== "admin" && sourceKind !== "dream") {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory source kind is invalid.");
  }
  return {
    id,
    content: normalizeContent(value.content),
    recordedAt,
    timeZone,
    conversationId: requiredLine(value.conversationId, "conversationId", 256),
    conversationScope: requiredLine(value.conversationScope, "conversationScope", 64),
    conversationTitle: optionalLine(value.conversationTitle, 500),
    sourceKind,
    batchId: optionalLine(value.batchId, 256),
    userId: optionalLine(value.userId, 64),
    userIds: normalizedStringArray(value.userIds, 64),
    userName: optionalLine(value.userName, 200),
    addressNames: normalizedStringArray(value.addressNames, 200),
    occurredAt: optionalTimestamp(value.occurredAt),
    occurredEndAt: optionalTimestamp(value.occurredEndAt),
    eventType: optionalLine(value.eventType, 100),
    subjectKey: optionalLine(value.subjectKey, 200),
    eventKey: optionalLine(value.eventKey, 256),
    causalChainKey: optionalLine(value.causalChainKey, 256),
    sourceMemoryIds: normalizedStringArray(value.sourceMemoryIds, 128),
    memoryKind: optionalLine(value.memoryKind, 64),
    realityStatus: optionalLine(value.realityStatus, 64),
    factuality: optionalLine(value.factuality, 64),
    dreamRunId: optionalLine(value.dreamRunId, 128),
    dreamDate: optionalLine(value.dreamDate, 32),
    dreamReviewedAt: optionalTimestamp(value.dreamReviewedAt)
  };
}

async function resolveWorkingMemoryPath(config: AppConfig) {
  const configured = resolveProjectPath(config.persona.agentWorkspace);
  if (!configured) throw workingMemoryError("WORKING_MEMORY_PATH_INVALID", "Agent workspace is not configured.");
  const workspace = path.resolve(configured);
  await assertWorkspaceDirectory(workspace);
  return path.join(workspace, WORKING_MEMORY_FILE);
}

async function assertWorkspaceDirectory(workspace: string) {
  const stat = await fs.lstat(workspace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) {
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    return assertWorkspaceDirectory(workspace);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw workingMemoryError("WORKING_MEMORY_PATH_INVALID", "Working memory workspace must be a regular directory.");
  }
}

async function assertReplaceTarget(filePath: string) {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw workingMemoryError("WORKING_MEMORY_PATH_INVALID", "WORKING_MEMORY.md must be a regular file.");
  }
}

async function readOptionalRegularFile(filePath: string) {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw workingMemoryError("WORKING_MEMORY_PATH_INVALID", "WORKING_MEMORY.md must be a regular file.");
    }
    if (stat.size > WORKING_MEMORY_MAX_BYTES) {
      throw workingMemoryError("WORKING_MEMORY_TOO_LARGE", "WORKING_MEMORY.md exceeds the 64 KiB limit.");
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw workingMemoryError("WORKING_MEMORY_PATH_INVALID", "WORKING_MEMORY.md cannot be a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeContent(value: unknown) {
  const content = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!content || content.length > WORKING_MEMORY_MAX_ITEM_CHARS || content.includes(ITEM_MARKER)) {
    throw workingMemoryError(
      "WORKING_MEMORY_ITEM_INVALID",
      `Working memory content must contain 1 to ${WORKING_MEMORY_MAX_ITEM_CHARS} characters.`
    );
  }
  return content;
}

function requiredLine(value: unknown, field: string, maxLength: number) {
  const normalized = optionalLine(value, maxLength);
  if (!normalized) throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", `Working memory ${field} is required.`);
  return normalized;
}

function optionalLine(value: unknown, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "";
  if (normalized.length > maxLength || /[\r\n\0]/u.test(normalized)) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory metadata contains invalid text.");
  }
  return normalized;
}

function normalizedStringArray(value: unknown, maxLength: number) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory metadata list is invalid.");
  }
  const values = [...new Set(value.map((item) => optionalLine(item, maxLength)).filter(Boolean))];
  return values.length ? values : undefined;
}

function boundedOpaqueMetadata(value: unknown, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "";
  if (/[\r\n\0]/u.test(normalized)) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory metadata contains invalid text.");
  }
  return normalized.length <= maxLength
    ? normalized
    : `sha256:${crypto.createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

function optionalTimestamp(value: unknown) {
  const normalized = optionalLine(value, 64);
  if (!normalized) return undefined;
  if (!Number.isFinite(Date.parse(normalized))) {
    throw workingMemoryError("WORKING_MEMORY_ITEM_INVALID", "Working memory event time is invalid.");
  }
  return normalized;
}

function assertDocumentSize(content: string) {
  if (Buffer.byteLength(content, "utf8") > WORKING_MEMORY_MAX_BYTES) {
    throw workingMemoryError("WORKING_MEMORY_TOO_LARGE", "WORKING_MEMORY.md exceeds the 64 KiB limit.");
  }
}

function revision(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function workingMemoryError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
