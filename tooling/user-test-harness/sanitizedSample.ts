import crypto from "node:crypto";
import type { ConversationRecord } from "../../packages/contracts/messaging/messages.js";
import type { WorkingMemoryDocumentItem } from "../../services/memory/workingMemoryDocument.js";
import { isMemoryEligibleConversationMessage } from "../../src/runtime/conversationMemoryHelpers.js";
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
  private readonly scopedNames = new Map<string, string>();
  private readonly nameOwners = new Map<string, string>();
  private readonly ambiguousNames = new Set<string>();
  private readonly textReplacements = new Map<string, {
    replacement: string;
    mode: "any" | "boundary";
  }>();
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
    collectFreeTextNameMappings(input, this);
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
    const messageSelection = summarizeMessageSelection(input.conversations);
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
      messageSelection,
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

  identifier(kind: string, value: unknown, projectToText = true) {
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
    if (projectToText && shouldProjectIdentifierInText(source)) {
      this.textReplacements.set(source, { replacement, mode: "any" });
    }
    return replacement;
  }

  numericIdentifier(kind: "user" | "group", value: unknown) {
    const replacement = this.identifier(kind, value);
    const index = Number(replacement.slice(replacement.lastIndexOf("-") + 1));
    const number = (kind === "user" ? 9_000_000 : 8_000_000) + index;
    const source = String(value ?? "").trim();
    if (shouldProjectIdentifierInText(source)) {
      this.textReplacements.set(source, {
        replacement: String(number),
        mode: "any"
      });
    }
    return number;
  }

  name(value: unknown, mode: "any" | "boundary" | "none" = "boundary") {
    const source = String(value ?? "").trim();
    if (!source) return "";
    const replacement = this.identifier("name", source, false);
    if (mode !== "none" && source.length >= 2) {
      this.textReplacements.set(source, {
        replacement: this.ambiguousNames.has(source) ? "[ambiguous-name]" : replacement,
        mode: inferredNameProjectionMode(source, mode)
      });
    }
    return replacement;
  }

  pairedName(value: unknown, userId: unknown) {
    const source = String(value ?? "").trim();
    const ownerId = String(userId ?? "").trim();
    if (!source || !ownerId) return this.name(source);
    const key = `${ownerId}\u0000${source}`;
    const existing = this.scopedNames.get(key);
    if (existing) return existing;
    const currentOwner = this.nameOwners.get(source);
    const replacement = currentOwner == null || currentOwner === ownerId
      ? this.name(source)
      : this.identifier("name", key, false);
    if (currentOwner == null) this.nameOwners.set(source, ownerId);
    else if (currentOwner !== ownerId) {
      this.ambiguousNames.add(source);
      if (source.length >= 2) {
        this.textReplacements.set(source, {
          replacement: "[ambiguous-name]",
          mode: inferredNameProjectionMode(source, "boundary")
        });
      }
    }
    this.scopedNames.set(key, replacement);
    return replacement;
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
    const protectedReplacements: string[] = [];
    const protect = (replacement: string) => {
      const token = identityProtectionToken(protectedReplacements.length);
      protectedReplacements.push(replacement);
      return token;
    };
    output = this.protectTypedFreeTextIdentifiers(output, protect);
    output = this.protectExplicitIdentityPairs(output, protect);
    for (const [source, replacement] of [...this.textReplacements.entries()]
      .sort((left, right) => right[0].length - left[0].length)) {
      const token = identityProtectionToken(protectedReplacements.length);
      const next = replacement.mode === "any"
        ? output.split(source).join(token)
        : replaceBoundedIdentity(output, source, token);
      if (next !== output) {
        protectedReplacements.push(replacement.replacement);
        output = next;
      }
    }
    if (containsOpaqueForwardedContent(output)) {
      return "[forwarded-content-redacted]";
    }
    if (containsSensitivePersonalEvent(output)) {
      return "[sensitive-content-redacted]";
    }
    output = output
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
      .replace(/\bhttps?:\/\/[^\s"'`<>]+/giu, "[url]")
      .replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.+-Z]+/gu, "[time]")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, "[date]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[credential]")
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "[credential]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[credential]")
      .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu, "[credential]")
      .replace(/[A-Za-z0-9_-]{24,}/gu, "[identifier]")
      .replace(/\d{5,}/gu, "[number]")
      .replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gu, "[date]")
      .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/gu, "[date]")
      .replace(/\d{1,2}\s*(?:点|时)\s*\d{0,2}\s*分?/gu, "[time]")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, "[time]")
      .replace(/(?:中国|日本|韩国|美国|英国|法国|德国|俄罗斯|台湾|新疆|西藏|内蒙古|北京|上海|天津|重庆|香港|澳门|杭州|广州|深圳|成都|武汉|西安|南京|苏州|福州|平潭|安吉|西湖)(?:市|县|区)?/gu, "[location]")
      .replace(/(QQ\s*\[number\]\s*[（(])[^）)\n]{1,64}([）)])/gu, "$1[name]$2")
      .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/srv\/)[^\s"'`]+/gu, "[path]");
    protectedReplacements.forEach((replacement, index) => {
      output = output.split(identityProtectionToken(index)).join(replacement);
    });
    return output;
  }

  private protectTypedFreeTextIdentifiers(
    value: string,
    protect: (replacement: string) => string
  ) {
    return value
      .replace(
        /(\[回复消息[：:]\s*)(\d{5,})(\s*\])/gu,
        (_match, prefix: string, messageId: string, suffix: string) => (
          `${prefix}${protect(this.identifier("message", messageId))}${suffix}`
        )
      )
      .replace(
        /@(\d{5,18})/gu,
        (_match, userId: string) => (
          `@${protect(String(this.numericIdentifier("user", userId)))}`
        )
      )
      .replace(
        /人物-([A-Za-z0-9_-]{6,})/gu,
        (_match, personId: string) => (
          protect(this.identifier("name", `person:${personId}`, false))
        )
      );
  }

  private protectExplicitIdentityPairs(
    value: string,
    protect: (replacement: string) => string
  ) {
    const forward = value.replace(
      /QQ\s*(\d{5,18})\s*[（(]([^）)\n]{1,64})[）)]/gu,
      (_match, userId: string, names: string) => {
        const projectedUserId = protect(String(this.numericIdentifier("user", userId)));
        const projectedNames = explicitNameCandidates(names, 1)
          .map((name) => protect(this.pairedName(name, userId)));
        return projectedNames.length
          ? `QQ ${projectedUserId}（${projectedNames.join("、")}）`
          : `QQ ${projectedUserId}`;
      }
    );
    return forward.replace(
      /([\p{Letter}\p{Number}_-]{1,64})\s*[（(]\s*QQ\s*(\d{5,18})\s*[）)]/gu,
      (_match, name: string, userId: string) => (
        `${protect(this.pairedName(name, userId))}（QQ ${protect(
          String(this.numericIdentifier("user", userId))
        )}）`
      )
    );
  }

  generic(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (structuralTimestampKey(key)) return this.timestamp(value);
      if (timestampKey(key) && parseTimestamp(value) != null) return this.timestamp(value);
      if (userIdKey(key)) return String(this.numericIdentifier("user", value));
      if (groupIdKey(key)) return String(this.numericIdentifier("group", value));
      if (idKey(key)) return this.identifier(genericIdKind(key), value);
      if (nameKey(key)) return this.name(value, "none");
      return this.text(value);
    }
    if (typeof value === "number") {
      if (userIdKey(key)) return this.numericIdentifier("user", value);
      if (groupIdKey(key)) return this.numericIdentifier("group", value);
      if (idKey(key)) return this.identifier(genericIdKind(key), value);
      if (sourcePositionKey(key)) return 0;
      return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => this.generic(item, key));
      return nameKey(key)
        ? items.filter((item) => typeof item === "string" && item.trim())
        : items;
    }
    if (!value || typeof value !== "object") return value;
    const ownerId = primaryUserIdentity(value);
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, item]) => {
      const sanitized = ownerId && personNameKey(childKey)
        ? sanitizeScopedNameValue(item, ownerId, this)
        : this.generic(item, childKey);
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
      .filter(isMemoryEligibleConversationMessage)
      .sort((left, right) => (
        Number(left.sequence ?? 0) - Number(right.sequence ?? 0) ||
        String(left.id ?? "").localeCompare(String(right.id ?? ""))
      ))
      .flatMap((message, index) => {
        const text = stripUnavailableMessageSegments(message.text);
        if (!text) return [];
        return [{
          id: this.identifier("message", message.id ?? `${conversation.id}:${index + 1}`),
          role: message.role,
          text: this.text(text),
          at: this.timestamp(message.at ?? conversation.lastAt),
          ...(message.userId == null ? {} : {
            userId: this.numericIdentifier("user", message.userId)
          }),
          ...(message.senderName ? {
            senderName: this.pairedName(message.senderName, message.userId)
          } : {}),
          imageCount: messageImageCount(message),
          quoteCount: messageQuoteCount(message)
        }];
      })
      .map((message, index) => ({ ...message, sequence: index + 1 }));
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
    const ownerId = userId || (userIds.length === 1 ? userIds[0]! : "");
    const userName = ownerId
      ? this.pairedName(item.userName, ownerId)
      : this.name(item.userName);
    const addressNames = (item.addressNames ?? [])
      .map((name) => ownerId ? this.pairedName(name, ownerId) : this.name(name))
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
        if (message.senderName) this.pairedName(message.senderName, message.userId);
      }
    }
    for (const item of input.workingMemory) {
      this.identifier("memory", item.id);
      this.identifier("conversation", item.conversationId);
      if (item.userId != null) this.numericIdentifier("user", item.userId);
      item.userIds?.forEach((id) => this.numericIdentifier("user", id));
      const ownerId = item.userId ?? (
        item.userIds?.length === 1 ? item.userIds[0] : undefined
      );
      if (item.userName) {
        if (ownerId != null) this.pairedName(item.userName, ownerId);
        else this.name(item.userName);
      }
      item.addressNames?.forEach((name) => {
        if (ownerId != null) this.pairedName(name, ownerId);
        else this.name(name);
      });
    }
    this.name(input.persona.name, "any");
  }
}

function summarizeMessageSelection(conversations: readonly ConversationRecord[]) {
  const result = {
    source: 0,
    productionEligible: 0,
    included: 0,
    mediaSegments: 0,
    quoteSegments: 0,
    excluded: {
      internal: 0,
      failed: 0,
      running: 0,
      other: 0,
      segmentOnly: 0
    }
  };
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      result.source += 1;
      result.mediaSegments += messageMediaCount(message);
      result.quoteSegments += messageQuoteCount(message);
      if (isMemoryEligibleConversationMessage(message)) {
        result.productionEligible += 1;
        if (stripUnavailableMessageSegments(message.text)) result.included += 1;
        else result.excluded.segmentOnly += 1;
      } else if (message.visibility === "internal" || message.eventKind === "orchestrator_decision") {
        result.excluded.internal += 1;
      } else if (message.requestStatus === "failed") {
        result.excluded.failed += 1;
      } else if (message.requestStatus === "running") {
        result.excluded.running += 1;
      } else {
        result.excluded.other += 1;
      }
    }
  }
  return result;
}

function stripUnavailableMessageSegments(value: unknown) {
  return String(value ?? "")
    .replace(
      /\[(?:(?:内容|表情)图片#\d+(?:：[^\]]*)?|(?:视频|语音|文件|在线文件|闪传文件)：[^\]]*)\]\s*/gu,
      ""
    )
    .replace(/\[回复消息：[^\]]+\]\s*/gu, "")
    .trim();
}

function messageImageCount(message: ConversationRecord["messages"][number]) {
  const placeholders = String(message.text ?? "")
    .match(/\[(?:内容|表情)图片#\d+(?:：[^\]]*)?\]/gu)?.length ?? 0;
  return Math.max(message.imageUrls?.length ?? 0, placeholders);
}

function messageQuoteCount(message: ConversationRecord["messages"][number]) {
  const placeholders = String(message.text ?? "").match(/\[回复消息：[^\]]+\]/gu)?.length ?? 0;
  return Math.max(message.quoteReferences?.length ?? 0, placeholders);
}

function messageMediaCount(message: ConversationRecord["messages"][number]) {
  const text = String(message.text ?? "");
  const audioVideoPlaceholders = text.match(/\[(?:视频|语音)：[^\]]*\]/gu)?.length ?? 0;
  const filePlaceholders = text.match(
    /\[(?:文件|在线文件|闪传文件)：[^\]]*\]/gu
  )?.length ?? 0;
  return messageImageCount(message) +
    audioVideoPlaceholders +
    Math.max(message.attachments?.length ?? 0, filePlaceholders);
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
    if (userIdKey(key)) sanitizer.numericIdentifier("user", value);
    if (groupIdKey(key)) sanitizer.numericIdentifier("group", value);
    if (idKey(key)) sanitizer.identifier(genericIdKind(key), value);
    if (nameKey(key)) sanitizer.name(value, "none");
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
  const ownerId = primaryUserIdentity(value);
  Object.entries(value).forEach(([childKey, item]) => {
    if (ownerId && personNameKey(childKey)) {
      for (const name of stringValues(item)) sanitizer.pairedName(name, ownerId);
      return;
    }
    collectGenericMappings(item, sanitizer, childKey);
  });
}

function collectFreeTextNameMappings(value: unknown, sanitizer: SampleSanitizer) {
  if (typeof value === "string") {
    for (const match of value.matchAll(
      /QQ\s*(\d{5,18})\s*[（(]([^）)\n]{1,64})[）)]/gu
    )) {
      for (const candidate of explicitNameCandidates(match[2], 1)) {
        sanitizer.pairedName(candidate, match[1]);
      }
    }
    for (const match of value.matchAll(
      /([\p{Letter}\p{Number}_-]{1,64})\s*[（(]\s*QQ\s*(\d{5,18})\s*[）)]/gu
    )) {
      sanitizer.pairedName(match[1], match[2]);
    }
    const patterns = [
      /(?:昵称|别名|显示名|称作|简称|自称|用户名)(?:为|是|：)?\s*[“"]([^”"\n]{1,64})[”"]/gu,
      /称呼(?:为|作|是|：)\s*[“"]([^”"\n]{1,64})[”"]/gu
    ];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        for (const candidate of explicitNameCandidates(match[1])) {
          if (!GENERIC_NAME_CANDIDATES.has(candidate)) sanitizer.name(candidate, "any");
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectFreeTextNameMappings(item, sanitizer));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach((item) => collectFreeTextNameMappings(item, sanitizer));
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

function shouldProjectIdentifierInText(value: string) {
  return /^\d{5,}$/u.test(value) ||
    value.length >= 8 && /[A-Za-z0-9]/u.test(value);
}

function inferredNameProjectionMode(
  source: string,
  requested: "any" | "boundary"
): "any" | "boundary" {
  if (requested === "any") return "any";
  const characters = [...source];
  if (characters.length >= 3) return "any";
  if (characters.length === 2 && characters[0] === characters[1]) return "any";
  return "boundary";
}

function identityProtectionToken(index: number) {
  return `\uE000${index.toString(36).replace(/\d/gu, (digit) => (
    String.fromCharCode("A".charCodeAt(0) + Number(digit))
  ))}\uE001`;
}

function replaceBoundedIdentity(value: string, source: string, replacement: string) {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const index = value.indexOf(source, cursor);
    if (index < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, index);
    const before = index > 0 ? value[index - 1] ?? "" : "";
    const afterIndex = index + source.length;
    const after = afterIndex < value.length ? value[afterIndex] ?? "" : "";
    if (!identityWordCharacter(before) && !identityWordCharacter(after)) {
      output += replacement;
    } else {
      output += source;
    }
    cursor = afterIndex;
  }
  return output;
}

function identityWordCharacter(value: string) {
  return /[\p{Letter}\p{Number}_]/u.test(value);
}

function explicitNameCandidates(value: unknown, minimumLength = 2) {
  return String(value ?? "")
    .split(/[、,，;；|/]+/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => (
      candidate.length >= minimumLength &&
      /[\p{Letter}\p{Number}]/u.test(candidate)
    ));
}

function sanitizeScopedNameValue(
  value: unknown,
  ownerId: string,
  sanitizer: SampleSanitizer
) {
  if (typeof value === "string") return sanitizer.pairedName(value, ownerId);
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === "string"
        ? sanitizer.pairedName(item, ownerId)
        : sanitizer.generic(item))
      .filter((item) => typeof item !== "string" || item.trim());
  }
  return sanitizer.generic(value);
}

function primaryUserIdentity(value: object) {
  const record = value as Record<string, unknown>;
  const direct = String(record.userId ?? "").trim();
  if (direct) return direct;
  if (!Array.isArray(record.userIds) || record.userIds.length !== 1) return "";
  return String(record.userIds[0] ?? "").trim();
}

function stringValues(value: unknown) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function timestampKey(key: string) {
  return /(?:^at$|At$|time$|timestamp$|date$)/iu.test(key);
}

function structuralTimestampKey(key: string) {
  return /(?:At|Timestamp)$/u.test(key);
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

function sourcePositionKey(key: string) {
  return /(?:sequence|position|cursor|compressedMessageStart|compressedMessageEnd)$/iu.test(key);
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

function personNameKey(key: string) {
  return /^(?:nickname|senderName|displayName|card|remark|userName|addressNames?)$/iu.test(key);
}

function containsOpaqueForwardedContent(value: string) {
  return /(?:聊天记录|小程序|短视频|mqqapi|\[CQ:json|JSON卡片)/iu.test(value) &&
    /(?:https?:\/\/|\d{12,}|\bJSON\b|\[CQ:json|JSON卡片)/iu.test(value) ||
    /^\s*\{[\s\S]{0,16}"(?:app|meta|prompt|desc|view)"/iu.test(value);
}

function containsSensitivePersonalEvent(value: string) {
  if (
    /(?:省|市|自治区|自治州|区|县).{0,80}(?:大道|路|街|道|巷|弄).{0,32}(?:\d{1,5}号|[一二三四五六七八九十百]+号|\d{1,5}(?:栋|幢|座|楼|层|室))/u.test(value)
  ) return true;
  if (
    /(?:户口|籍贯|东北人|房产|房子|住址|门牌|工资|薪资|身份证|护照|银行卡|资产|未成年人|医疗资料|体重|公斤|千克|斤|就医|住院|胃肠镜|疼痛|生病|药物|吃药|服药|泻药|便秘药|饮水量|低钠|校园网)/u.test(value)
  ) return true;
  const itinerary = /(?:拍摄|拍照|行程|酒店|住宿|航班|火车|高铁|漫展|活动|集合|开拍|出发|返程|旅行)/u.test(value);
  const specificTimeOrPlace = /(?:\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*(?:点|时)|上午|下午|晚间|周末|中国|日本|韩国|美国|英国|法国|德国|俄罗斯|台湾|新疆|西藏|内蒙古|北京|上海|天津|重庆|香港|澳门|杭州|广州|深圳|成都|武汉|西安|南京|苏州|福州|平潭|安吉|西湖|(?:省|市|自治区|自治州|区|县|镇|乡|村|大道|路|街|道|巷|弄))/u
    .test(value);
  return itinerary && specificTimeOrPlace;
}

const GENERIC_NAME_CANDIDATES = new Set([
  "大家",
  "对方",
  "用户",
  "老师",
  "机器人",
  "管理员",
  "同行者",
  "别人",
  "自己"
]);
