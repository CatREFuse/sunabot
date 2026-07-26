import crypto from "node:crypto";
import type { ConversationRecord } from "../../packages/contracts/messaging/messages.js";
import type { WorkingMemoryDocumentItem } from "../../services/memory/workingMemoryDocument.js";
import type {
  DreamPersonaFixture,
  JsonFixtureRecord,
  SanitizedBranchSampleV2,
  WorkingMemoryFixtureItem
} from "./contracts.js";

const SYNTHETIC_EPOCH_MS = Date.parse("2024-01-01T00:00:00.000Z");

export function buildSanitizedBranchSample(input: {
  workingMemory: readonly WorkingMemoryDocumentItem[];
  conversations: readonly ConversationRecord[];
  longTerm: readonly JsonFixtureRecord[];
  userProfiles: readonly JsonFixtureRecord[];
  persona: DreamPersonaFixture;
}): SanitizedBranchSampleV2 {
  const sanitizer = new SampleSanitizer(input);
  const fixture = sanitizer.fixture(input);
  return {
    schemaVersion: 2,
    kind: "sunabot.user-test.sanitized-branch-sample",
    redaction: {
      version: "sunabot-user-test-v2",
      irreversible: true,
      mappingPersisted: false,
      timestampPolicy: "relative-shifted-utc-minute",
      freeTextReviewRequired: true
    },
    integrity: {
      canonicalization: "json-stringify-v1",
      payloadSha256: crypto.createHash("sha256")
        .update(JSON.stringify(fixture))
        .digest("hex")
    },
    fixture
  };
}

export function validateSanitizedBranchSample(value: unknown): SanitizedBranchSampleV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("USER_TEST_SANITIZED_SAMPLE_INVALID");
  }
  const sample = value as Partial<SanitizedBranchSampleV2>;
  if (
    sample.schemaVersion !== 2 ||
    sample.kind !== "sunabot.user-test.sanitized-branch-sample" ||
    sample.redaction?.version !== "sunabot-user-test-v2" ||
    sample.redaction.irreversible !== true ||
    sample.redaction.mappingPersisted !== false ||
    sample.redaction.timestampPolicy !== "relative-shifted-utc-minute" ||
    sample.redaction.freeTextReviewRequired !== true ||
    sample.integrity?.canonicalization !== "json-stringify-v1" ||
    !/^[0-9a-f]{64}$/u.test(String(sample.integrity.payloadSha256 ?? "")) ||
    !sample.fixture ||
    typeof sample.fixture !== "object" ||
    Array.isArray(sample.fixture)
  ) {
    throw new Error("USER_TEST_SANITIZED_SAMPLE_INVALID");
  }
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify(sample.fixture))
    .digest("hex");
  if (digest !== sample.integrity.payloadSha256) {
    throw new Error("USER_TEST_SANITIZED_SAMPLE_DIGEST_MISMATCH");
  }
  return sample as SanitizedBranchSampleV2;
}

class SampleSanitizer {
  private readonly maps = new Map<string, Map<string, string>>();
  private readonly replacements = new Map<string, string>();
  private readonly timestampOrigin: number;
  private maxShiftedTimestamp = SYNTHETIC_EPOCH_MS;

  constructor(input: {
    workingMemory: readonly WorkingMemoryDocumentItem[];
    conversations: readonly ConversationRecord[];
    longTerm: readonly JsonFixtureRecord[];
    userProfiles: readonly JsonFixtureRecord[];
    persona: DreamPersonaFixture;
  }) {
    const timestamps: number[] = [];
    collectTimestamps(input, timestamps);
    this.timestampOrigin = timestamps.length ? Math.min(...timestamps) : SYNTHETIC_EPOCH_MS;
    this.collectStructuredMappings(input);
    collectGenericMappings(input.longTerm, this);
    collectGenericMappings(input.userProfiles, this);
  }

  fixture(input: {
    workingMemory: readonly WorkingMemoryDocumentItem[];
    conversations: readonly ConversationRecord[];
    longTerm: readonly JsonFixtureRecord[];
    userProfiles: readonly JsonFixtureRecord[];
    persona: DreamPersonaFixture;
  }) {
    const conversations = [...input.conversations]
      .sort((left, right) => (
        String(right.lastAt ?? "").localeCompare(String(left.lastAt ?? "")) ||
        String(left.id).localeCompare(String(right.id))
      ))
      .flatMap((conversation) => {
        const sanitized = this.conversation(conversation);
        return sanitized.messages.length ? [sanitized] : [];
      });
    const workingMemory = [...input.workingMemory]
      .sort((left, right) => (
        String(left.occurredAt ?? left.recordedAt).localeCompare(
          String(right.occurredAt ?? right.recordedAt)
        ) ||
        left.id.localeCompare(right.id)
      ))
      .map((item) => this.workingMemory(item));
    return {
      now: new Date(this.maxShiftedTimestamp + 60 * 60_000).toISOString(),
      workingMemory,
      longTerm: input.longTerm.map((record) => this.generic(record) as JsonFixtureRecord),
      userProfiles: input.userProfiles.map((record) => this.generic(record) as JsonFixtureRecord),
      persona: {
        name: "fixture-agent",
        soul: this.text(input.persona.soul),
        preference: this.text(input.persona.preference),
        user: this.text(input.persona.user),
        relation: this.text(input.persona.relation),
        air: this.text(input.persona.air)
      },
      conversations
    };
  }

  identifier(kind: string, value: unknown) {
    const source = String(value ?? "").trim();
    if (!source) return `${kind}-0000`;
    let values = this.maps.get(kind);
    if (!values) {
      values = new Map();
      this.maps.set(kind, values);
    }
    let replacement = values.get(source);
    if (!replacement) {
      replacement = `${kind}-${String(values.size + 1).padStart(4, "0")}`;
      values.set(source, replacement);
    }
    this.replacements.set(source, replacement);
    return replacement;
  }

  numericIdentifier(kind: "user" | "group", value: unknown) {
    const replacement = this.identifier(kind, value);
    const index = Number(replacement.slice(replacement.lastIndexOf("-") + 1));
    const number = (kind === "user" ? 9_000_000 : 8_000_000) + index;
    this.replacements.set(String(value), String(number));
    return number;
  }

  name(value: unknown) {
    const source = String(value ?? "").trim();
    if (!source) return "";
    return this.identifier("name", source);
  }

  timestamp(value: unknown) {
    const parsed = parseTimestamp(value);
    if (parsed == null) return new Date(SYNTHETIC_EPOCH_MS).toISOString();
    const shifted = SYNTHETIC_EPOCH_MS +
      Math.round((parsed - this.timestampOrigin) / 60_000) * 60_000;
    this.maxShiftedTimestamp = Math.max(this.maxShiftedTimestamp, shifted);
    return new Date(shifted).toISOString();
  }

  calendarDate(value: unknown) {
    const source = String(value ?? "").trim();
    const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(source)
      ? Date.parse(`${source}T12:00:00.000Z`)
      : Number.NaN;
    if (!Number.isFinite(parsed)) return "";
    const shifted = SYNTHETIC_EPOCH_MS +
      Math.round((parsed - this.timestampOrigin) / 60_000) * 60_000;
    this.maxShiftedTimestamp = Math.max(this.maxShiftedTimestamp, shifted);
    return new Date(shifted).toISOString().slice(0, 10);
  }

  text(value: unknown) {
    let output = String(value ?? "");
    for (const [source, replacement] of [...this.replacements.entries()]
      .filter(([source]) => source.length >= 2)
      .sort((left, right) => right[0].length - left[0].length)) {
      output = output.split(source).join(replacement);
    }
    return output
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
      .replace(/\bhttps?:\/\/[^\s"'`<>]+/giu, "[url]")
      .replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.+-Z]+/gu, "[time]")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, "[date]")
      .replace(/\b\d{5,18}\b/gu, "[number]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[credential]")
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "[credential]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[credential]")
      .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu, "[credential]")
      .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/srv\/)[^\s"'`]+/gu, "[path]");
  }

  generic(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (timestampKey(key) && parseTimestamp(value) != null) return this.timestamp(value);
      if (idKey(key)) return this.identifier(genericIdKind(key), value);
      if (nameKey(key)) return this.name(value);
      return this.text(value);
    }
    if (typeof value === "number") {
      if (userIdKey(key)) return this.numericIdentifier("user", value);
      if (groupIdKey(key)) return this.numericIdentifier("group", value);
      if (idKey(key)) return this.identifier(genericIdKind(key), value);
      return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => this.generic(item, key));
      return nameKey(key)
        ? items.filter((item) => typeof item === "string" && item.trim())
        : items;
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, item]) => {
      const sanitized = this.generic(item, childKey);
      if (
        nameKey(childKey) &&
        (
          (typeof sanitized === "string" && !sanitized.trim()) ||
          (Array.isArray(sanitized) && sanitized.length === 0)
        )
      ) return [];
      return [[childKey, sanitized]];
    }));
  }

  private conversation(conversation: ConversationRecord) {
    const id = this.identifier("conversation", conversation.id);
    const messages = [...conversation.messages]
      .sort((left, right) => (
        Number(left.sequence ?? 0) - Number(right.sequence ?? 0) ||
        String(left.id ?? "").localeCompare(String(right.id ?? ""))
      ))
      .flatMap((message, index) => {
        if (
          (message.role !== "user" && message.role !== "assistant") ||
          !String(message.text ?? "").trim()
        ) return [];
        return [{
          id: this.identifier("message", message.id ?? `${conversation.id}:${index + 1}`),
          sequence: Number.isSafeInteger(message.sequence) && Number(message.sequence) > 0
            ? Number(message.sequence)
            : index + 1,
          role: message.role,
          text: this.text(message.text),
          at: this.timestamp(message.at ?? conversation.lastAt),
          ...(message.userId == null ? {} : {
            userId: this.numericIdentifier("user", message.userId)
          }),
          ...(message.senderName ? { senderName: this.name(message.senderName) } : {})
        }];
      });
    return {
      id,
      scope: normalizeScope(conversation.scope),
      title: id,
      userId: this.numericIdentifier("user", conversation.userId || `${conversation.id}:user`),
      ...(conversation.groupId == null ? {} : {
        groupId: this.numericIdentifier("group", conversation.groupId)
      }),
      messages
    };
  }

  private workingMemory(item: WorkingMemoryDocumentItem): WorkingMemoryFixtureItem {
    const batchId = nonEmptyText(item.batchId);
    const userId = nonEmptyText(item.userId);
    const userIds = (item.userIds ?? []).map(nonEmptyText).filter(Boolean);
    const userName = this.name(item.userName);
    const addressNames = (item.addressNames ?? [])
      .map((name) => this.name(name))
      .filter(Boolean);
    const occurredEndAt = nonEmptyText(item.occurredEndAt);
    const sourceMemoryIds = (item.sourceMemoryIds ?? []).map(nonEmptyText).filter(Boolean);
    const dreamRunId = nonEmptyText(item.dreamRunId);
    const dreamDate = this.calendarDate(item.dreamDate);
    const dreamReviewedAt = nonEmptyText(item.dreamReviewedAt);
    return {
      id: this.identifier("memory", item.id),
      content: this.text(item.content),
      occurredAt: this.timestamp(item.occurredAt ?? item.recordedAt),
      recordedAt: this.timestamp(item.recordedAt),
      timeZone: "UTC",
      conversationId: this.identifier("conversation", item.conversationId),
      conversationScope: normalizeScope(item.conversationScope),
      conversationTitle: this.identifier("conversation", item.conversationId),
      sourceKind: item.sourceKind,
      ...(batchId ? {
        batchId: this.identifier("batch", batchId)
      } : {}),
      ...(userId ? {
        userId: String(this.numericIdentifier("user", userId))
      } : {}),
      ...(userIds.length ? {
        userIds: userIds.map((id) => String(this.numericIdentifier("user", id)))
      } : {}),
      ...(userName ? { userName } : {}),
      ...(addressNames.length ? { addressNames } : {}),
      ...(occurredEndAt ? {
        occurredEndAt: this.timestamp(occurredEndAt)
      } : {}),
      ...sanitizedTextField("eventType", item.eventType, this),
      ...sanitizedTextField("subjectKey", item.subjectKey, this),
      ...sanitizedTextField("eventKey", item.eventKey, this),
      ...sanitizedTextField("causalChainKey", item.causalChainKey, this),
      ...(sourceMemoryIds.length ? {
        sourceMemoryIds: sourceMemoryIds.map((id) => this.identifier("memory", id))
      } : {}),
      ...sanitizedTextField("memoryKind", item.memoryKind, this),
      ...sanitizedTextField("realityStatus", item.realityStatus, this),
      ...sanitizedTextField("factuality", item.factuality, this),
      ...(dreamRunId ? {
        dreamRunId: this.identifier("dream", dreamRunId)
      } : {}),
      ...(dreamDate ? { dreamDate } : {}),
      ...(dreamReviewedAt ? {
        dreamReviewedAt: this.timestamp(dreamReviewedAt)
      } : {})
    };
  }

  private collectStructuredMappings(input: {
    workingMemory: readonly WorkingMemoryDocumentItem[];
    conversations: readonly ConversationRecord[];
    persona: DreamPersonaFixture;
  }) {
    for (const conversation of input.conversations) {
      this.identifier("conversation", conversation.id);
      this.numericIdentifier("user", conversation.userId || `${conversation.id}:user`);
      if (conversation.groupId != null) this.numericIdentifier("group", conversation.groupId);
      this.name(conversation.title);
      for (const message of conversation.messages) {
        if (message.id != null) this.identifier("message", message.id);
        if (message.userId != null) this.numericIdentifier("user", message.userId);
        if (message.senderName) this.name(message.senderName);
      }
    }
    for (const item of input.workingMemory) {
      this.identifier("memory", item.id);
      this.identifier("conversation", item.conversationId);
      if (item.userId != null) this.numericIdentifier("user", item.userId);
      item.userIds?.forEach((id) => this.numericIdentifier("user", id));
      if (item.userName) this.name(item.userName);
      item.addressNames?.forEach((name) => this.name(name));
    }
    this.name(input.persona.name);
  }
}

function collectTimestamps(value: unknown, output: number[], key = "") {
  if (typeof value === "string") {
    const parsed = timestampKey(key) ? parseTimestamp(value) : undefined;
    if (parsed != null) output.push(parsed);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTimestamps(item, output, key));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([childKey, item]) => (
    collectTimestamps(item, output, childKey)
  ));
}

function collectGenericMappings(value: unknown, sanitizer: SampleSanitizer, key = "") {
  if (typeof value === "string") {
    if (idKey(key)) sanitizer.identifier(genericIdKind(key), value);
    if (nameKey(key)) sanitizer.name(value);
    return;
  }
  if (typeof value === "number") {
    if (userIdKey(key)) sanitizer.numericIdentifier("user", value);
    if (groupIdKey(key)) sanitizer.numericIdentifier("group", value);
    if (idKey(key)) sanitizer.identifier(genericIdKind(key), value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectGenericMappings(item, sanitizer, key));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([childKey, item]) => (
    collectGenericMappings(item, sanitizer, childKey)
  ));
}

function sanitizedTextField<Key extends string>(
  key: Key,
  value: string | undefined,
  sanitizer: SampleSanitizer
): Partial<Record<Key, string>> {
  const sanitized = sanitizer.text(value).trim();
  return sanitized ? { [key]: sanitized } as Partial<Record<Key, string>> : {};
}

function normalizeScope(value: unknown): "private" | "user_group" | "bot_group" {
  return value === "private" || value === "bot_group" ? value : "user_group";
}

function parseTimestamp(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonEmptyText(value: unknown) {
  return String(value ?? "").trim();
}

function timestampKey(key: string) {
  return /(?:^at$|At$|time$|timestamp$|date$)/iu.test(key);
}

function userIdKey(key: string) {
  return /^(?:userIds?|qq|qqIds?|administratorQq)$/iu.test(key);
}

function groupIdKey(key: string) {
  return /^(?:groupIds?)$/iu.test(key);
}

function idKey(key: string) {
  return /(?:^id$|Id$|Ids$)/u.test(key) && !userIdKey(key) && !groupIdKey(key);
}

function genericIdKind(key: string) {
  if (/conversation/iu.test(key)) return "conversation";
  if (/message/iu.test(key)) return "message";
  if (/batch/iu.test(key)) return "batch";
  if (/dream/iu.test(key)) return "dream";
  return "record";
}

function nameKey(key: string) {
  return /^(?:nickname|senderName|displayName|card|remark|title|groupName|userName|addressNames?)$/iu.test(key);
}
