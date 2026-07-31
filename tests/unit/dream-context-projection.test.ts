import { describe, expect, it } from "vitest";
import {
  DREAM_CONTEXT_PROJECTION_LIMITS,
  dreamContextPayloadByteLength,
  projectDreamContext,
  projectDreamContextPayload
} from "../../src/runtime/dreamContextProjection.js";

const SEED = "a".repeat(64);
const OTHER_SEED = "b".repeat(64);

describe("Dream context projection", () => {
  it("projects a closed schema while preserving original names, address names, and QQ identities", () => {
    const raw = sensitivePayload();
    const before = structuredClone(raw);
    const payload = projectDreamContextPayload(raw);
    const serialized = JSON.stringify(payload);

    expect(raw).toEqual(before);
    expect(serialized).toContain("12345678");
    expect(serialized).toContain("海老师");
    expect(serialized).toContain("private:12345678");
    expect(serialized).not.toContain("/Users/tanshow/Developer/sunabot");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("extension-secret");
    expect(serialized).not.toMatch(/人物-[a-f0-9]{24}/u);
    expect(serialized).not.toMatch(/\b(?:person|profile|context|event|causal|subject|task|schedule|impression):[a-f0-9]{24}\b/u);
    expect(serialized).toContain("[已隐藏路径]");
    expect(serialized).toContain("[已隐藏敏感信息]");
    expect(findForbiddenKeys(payload)).toEqual([]);

    const working = objectArray(payload.workingMemories)[0]!;
    const longTerm = objectArray(payload.longTermMemories)[0]!;
    const workingMemory = objectValue(working.memory);
    const longTermMemory = objectValue(longTerm.memory);
    const profile = objectArray(payload.userProfiles)[0]!;
    const conversation = objectArray(payload.observedConversations)[0]!;
    const message = objectArray(conversation.messages)[0]!;
    const director = objectValue(payload.plannedDailySchedule);
    const directorItem = objectArray(director.items)[0]!;

    expect(workingMemory).toMatchObject({
      id: "working-1",
      factuality: "factual",
      userId: "12345678",
      userIds: ["12345678"],
      userName: "海老师",
      addressNames: ["海老师"],
      conversationId: "private:12345678",
      contextKey: "private:12345678",
      eventKey: "event:old-station",
      causalChainKey: "cause:promise-and-task",
      subjectKey: "subject:12345678",
      eventType: "task",
      importance: 0.8,
      futureRelevance: 0.9,
      emotionalSalience: 0.7,
      promoteToLongTerm: true
    });
    expect(longTermMemory).toMatchObject({
      userId: "12345678",
      eventKey: "event:old-station",
      causalChainKey: "cause:promise-and-task"
    });
    expect(String(workingMemory.fact)).toContain("海老师（12345678）");
    expect(profile).toMatchObject({
      id: "profile_12345678",
      userId: "12345678",
      userName: "海老师",
      addressNames: ["海老师"]
    });
    expect(conversation).toMatchObject({
      id: "private:12345678",
      title: "海老师"
    });
    expect(message).toMatchObject({
      userId: "12345678",
      senderName: "海老师"
    });
    expect(directorItem).toMatchObject({
      id: "director-item-secret",
      participants: ["海老师"]
    });
    expect(payload.sourceMemoryIds).toEqual(["working-1", "long-1"]);
    expect(payload.fieldKnowledgeEvidenceIds).toEqual(["working-1"]);
    expect(payload.fieldKnowledgeWritable).toBe(false);
    expect(payload.recentWindowHours).toBe(24);
    expect(objectArray(payload.activeTasks)[0]).toMatchObject({ enabled: true, status: "running" });
    expect(objectArray(payload.personaImpressions)[0]).toMatchObject({
      id: "persona-run-1",
      topicKey: "communication.evidence",
      level: "stable",
      targetFile: "PREFERENCE.md"
    });
    expect(String(objectArray(payload.personaImpressions)[0]?.statement)).toContain("海老师");
    expect(objectValue(payload.persona)).toMatchObject({
      id: "plana",
      name: "Plana",
      user: "海老师是长期伙伴。"
    });
    expect(objectArray(objectArray(payload.activeTasks)[0]?.targets)[0]).toEqual({
      conversationId: "private:12345678",
      mentionUserIds: ["12345678"]
    });
    expect(payload.scheduledFor).toBe("2026-07-20T04:00:00.000+08:00");
    expect(Object.keys(payload)).toEqual([
      "schemaVersion", "seed", "localDate", "scheduledFor", "timeZone", "memoryWindow",
      "workingMemories", "longTermMemories", "recallStats", "personaEvidenceIds",
      "fieldKnowledgeEvidenceIds", "fieldKnowledgeWritable", "recentWindowHours",
      "sourceMemoryIds", "userProfiles", "observedConversations", "activeTasks",
      "plannedDailySchedule", "personaImpressions", "persona"
    ]);
  });

  it("allows field-knowledge replacement only when the projected AIR is lossless", () => {
    const raw = sensitivePayload();
    raw.persona.air = [
      "# 场域知识",
      "",
      "## 使用边界",
      "",
      "- 仅适用于发布验收。",
      "",
      "## 场域约定",
      "",
      "- 发布前需要双人复核。"
    ].join("\r\n");

    const payload = projectDreamContextPayload(raw);

    expect(payload.fieldKnowledgeWritable).toBe(true);
    expect(objectValue(payload.persona).air).toBe(raw.persona.air.replaceAll("\r\n", "\n"));
  });

  it("keeps AIR identities readable without a local alias-binding contract", () => {
    const raw = sensitivePayload();
    raw.persona.air = "# 场域知识\n\n## 使用边界\n\n- 只在协作群生效。\n\n## 场域约定\n\n- 海老师负责发布前复核。";

    const projection = projectDreamContext(raw);
    const projectedAir = String(objectValue(projection.payload.persona).air);

    expect(projection.payload.fieldKnowledgeWritable).toBe(true);
    expect(projectedAir).toBe(raw.persona.air);
    expect(JSON.stringify(projection)).not.toContain("fieldKnowledgeBindings");
    expect(projectedAir).not.toMatch(/人物-[a-f0-9]{24}/u);
  });

  it("preserves identity numbers while redacting credentials, signed URLs, email, and absolute paths", () => {
    const raw = sensitivePayload();
    const awsAccess = "AKIAIOSFODNN7EXAMPLE";
    const awsSessionAccess = "ASIAIOSFODNN7EXAMPLE";
    const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const awsSession = "IQoJb3JpZ2luX2VjEP//////////wEaCXVzLWVhc3QtMSJHMEUC";
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const basic = "dXNlcjpwYXNzd29yZA==";
    const bearer = "opaque-bearer-token-value";
    raw.persona.soul = [
      "QQ 87654321，长号 62220202020202020202，邮箱 dreamer@example.com。",
      `AWS_ACCESS_KEY_ID=${awsAccess} AWS_SECRET_ACCESS_KEY="${awsSecret}" AWS_SESSION_TOKEN='${awsSession}'，裸 ${awsSessionAccess}。`,
      `JWT ${jwt}；Authorization: Basic ${basic}；Bearer ${bearer}。`,
      `签名一 https://bucket.example.com/report?X-Amz-Credential=${awsAccess}%2F20260720%2Ftest&X-Amz-Security-Token=${awsSession}&X-Amz-Signature=deadbeef。`,
      "签名二 https://cdn.example.com/file?Policy=private-policy&Signature=signed-value&Key-Pair-Id=pair-id。",
      "路径 /workspace/dream/input.json /srv/suna /app/runtime /data/sqlite /mnt/share /run/sunabot.sock /usr/local/bin/node。",
      "Windows C:\\Users\\Alice\\secret.txt D:/Data/dream.db；UNC \\\\nas01\\private$\\dream.txt //nas02/private$/dream.txt。",
      "保留 ISO=2026-07-20T04:00:00.000+08:00，时区 Asia/Shanghai 与 America/Los_Angeles，cron=0 4 * * *，step=*/5 * * * *。"
    ].join("\n");

    const soul = String(objectValue(projectDreamContextPayload(raw).persona).soul);
    for (const sensitive of [
      "dreamer@example.com", awsAccess, awsSessionAccess,
      awsSecret, awsSession, jwt, basic, bearer, "deadbeef", "private-policy", "signed-value", "pair-id",
      "/workspace", "/srv", "/app", "/data", "/mnt", "/run", "/usr/local/bin/node",
      "C:\\Users\\Alice", "D:/Data", "\\\\nas01\\private$", "//nas02/private$"
    ]) expect(soul).not.toContain(sensitive);
    expect(soul).toContain("QQ 87654321");
    expect(soul).toContain("长号 62220202020202020202");
    expect(soul).not.toMatch(/\b(?:Basic|Bearer)\b/iu);
    expect(soul).toContain("[已隐藏敏感信息]");
    expect(soul).toContain("[已隐藏路径]");
    expect(soul).toContain("2026-07-20T04:00:00.000+08:00");
    expect(soul).toContain("Asia/Shanghai");
    expect(soul).toContain("America/Los_Angeles");
    expect(soul).toContain("cron=0 4 * * *");
    expect(soul).toContain("step=*/5 * * * *");
  });

  it("applies the same sensitive-text redaction to every structured identity surface", () => {
    const raw = sensitivePayload();
    const tokenAssignment = "token=identity-secret-value";
    const email = "identity@example.com";
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "identity-private-key-value",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const bearer = "Bearer identity-bearer-token";
    const awsAccess = "AKIAIOSFODNN7EXAMPLE";
    const signedUrl = "https://bucket.example.com/report?X-Amz-Signature=identity-signature";
    const absolutePath = "/Users/alice/private/identity.txt";
    const githubToken = "ghp_identitysecretvalue";

    const workingMemory = objectValue(raw.workingMemories[0]!.memory);
    workingMemory.userName = tokenAssignment;
    workingMemory.addressNames = [email];
    raw.userProfiles[0]!.id = privateKey;
    raw.observedConversations[0]!.messages[0]!.senderName = bearer;
    raw.activeTasks[0]!.id = signedUrl;
    raw.activeTasks[0]!.targets[0]!.conversationId = signedUrl;
    raw.activeTasks[0]!.targets[0]!.mentionUserIds = [awsAccess];
    raw.plannedDailySchedule.items[0]!.id = absolutePath;
    raw.plannedDailySchedule.items[0]!.participants = [absolutePath];
    raw.personaImpressions[0]!.id = githubToken;
    raw.persona.id = absolutePath;
    raw.persona.name = tokenAssignment;

    const payload = projectDreamContextPayload(raw);
    const serialized = JSON.stringify(payload);
    for (const sensitive of [
      "identity-secret-value", email, "identity-private-key-value",
      "identity-bearer-token", awsAccess, "identity-signature",
      absolutePath, githubToken
    ]) expect(serialized).not.toContain(sensitive);

    expect(serialized).toContain("[已隐藏敏感信息]");
    expect(serialized).toContain("[已隐藏路径]");
    const projectedMemory = objectValue(objectArray(payload.workingMemories)[0]?.memory);
    expect(projectedMemory).toMatchObject({
      userId: "12345678",
      userName: "token=[已隐藏敏感信息]",
      addressNames: ["[已隐藏敏感信息]"]
    });
    expect(objectArray(payload.userProfiles)[0]?.id).toBe("[已隐藏敏感信息]");
    const projectedConversation = objectArray(payload.observedConversations)[0]!;
    expect(objectArray(projectedConversation.messages)[0]?.senderName).toBe("[已隐藏敏感信息]");
    expect(objectArray(projectedConversation.messages)[1]?.senderName).toBe("T");
    const projectedTask = objectArray(payload.activeTasks)[0]!;
    expect(projectedTask.id).toBe(
      "https://bucket.example.com/report?X-Amz-Signature=[已隐藏敏感信息]"
    );
    expect(objectArray(projectedTask.targets)[0]).toEqual({
      conversationId: "https://bucket.example.com/report?X-Amz-Signature=[已隐藏敏感信息]",
      mentionUserIds: ["[已隐藏敏感信息]"]
    });
    const projectedDirector = objectValue(payload.plannedDailySchedule);
    expect(objectArray(projectedDirector.items)[0]).toMatchObject({
      id: "[已隐藏路径]",
      participants: ["[已隐藏路径]"]
    });
    expect(objectArray(payload.personaImpressions)[0]?.id).toBe("[已隐藏敏感信息]");
    expect(objectValue(payload.persona)).toMatchObject({
      id: "[已隐藏路径]",
      name: "token=[已隐藏敏感信息]"
    });
  });

  it("is deterministic and keeps original identity fields stable when the seed changes", () => {
    const raw = sensitivePayload();
    const first = projectDreamContextPayload(raw);
    const second = projectDreamContextPayload(raw);
    const rotated = projectDreamContextPayload({ ...raw, seed: OTHER_SEED });
    const firstMemory = objectValue(objectArray(first.workingMemories)[0]!.memory);
    const rotatedMemory = objectValue(objectArray(rotated.workingMemories)[0]!.memory);

    expect(second).toEqual(first);
    expect(rotatedMemory).toEqual(firstMemory);
    expect(rotated.seed).toBe(OTHER_SEED);
    expect(first.seed).toBe(SEED);
  });

  it("applies explicit field, array, and total payload limits with deterministic tail clipping", () => {
    const huge = oversizedPayload();
    const first = projectDreamContext(huge);
    const second = projectDreamContext(huge);
    const payload = first.payload;
    const working = objectArray(payload.workingMemories);
    const longTerm = objectArray(payload.longTermMemories);
    const retainedIds = [...working, ...longTerm].map((item) => String(item.id));

    expect(second).toEqual(first);
    expect(first.byteLength).toBe(dreamContextPayloadByteLength(payload));
    expect(first.byteLength).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.totalPayloadBytes);
    expect(working.length).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.arrays.workingMemories);
    expect(longTerm.length).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.arrays.longTermMemories);
    expect(objectArray(payload.userProfiles).length).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.arrays.userProfiles);
    expect(objectArray(payload.observedConversations).length).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.arrays.conversations);
    expect(objectArray(payload.activeTasks).length).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.arrays.activeTasks);
    for (const item of [...working, ...longTerm]) {
      const fact = String(objectValue(item.memory).fact);
      expect([...fact].length).toBeLessThanOrEqual(DREAM_CONTEXT_PROJECTION_LIMITS.stringChars.memoryFact);
    }
    expect(stringArray(payload.sourceMemoryIds)).toEqual(retainedIds);
    expect(stringArray(payload.personaEvidenceIds).every((id) => retainedIds.includes(id))).toBe(true);
    expect(objectArray(payload.recallStats).every((item) => retainedIds.includes(String(item.recordId)))).toBe(true);
    expect(payload.fieldKnowledgeWritable).toBe(false);
  });

  it("fails closed on an invalid seed or a secret-shaped memory id", () => {
    expect(() => projectDreamContextPayload({ ...sensitivePayload(), seed: "not-a-digest" }))
      .toThrow("seed must be a SHA-256 digest");
    const raw = sensitivePayload();
    raw.workingMemories[0]!.id = "sk-supersecretmemoryid";
    expect(() => projectDreamContextPayload(raw)).toThrow("safe opaque memory id");
    const oversized = sensitivePayload();
    oversized.workingMemories[0]!.id = "m".repeat(129);
    expect(() => projectDreamContextPayload(oversized)).toThrow("safe opaque memory id");
  });
});

function sensitivePayload() {
  const memory = (id: string, fact: string) => ({
    id,
    factuality: "factual",
    memory: {
      id,
      fact,
      factuality: "factual",
      userId: "12345678",
      userIds: ["12345678"],
      userName: "海老师",
      addressNames: ["海老师"],
      conversationId: "private:12345678",
      contextKey: "private:12345678",
      eventKey: "event:old-station",
      causalChainKey: "cause:promise-and-task",
      subjectKey: "subject:12345678",
      eventType: "task",
      memoryKind: "working",
      occurredAt: "2026-07-19T12:00:00.000Z",
      createdAt: "2026-07-19T12:00:00.000Z",
      importance: 0.8,
      futureRelevance: 0.9,
      emotionalSalience: 0.7,
      promoteToLongTerm: true,
      arbitrary: "extension-secret"
    },
    recallStats: null,
    selection: {
      lane: "task",
      reasons: ["active_task_or_commitment", "unknown-extension"],
      score: 3.2,
      scoreComponents: { taskRelevance: 1, arbitrary: 1 }
    },
    arbitrary: "extension-secret"
  });
  return {
    schemaVersion: 1,
    seed: SEED,
    localDate: "2026-07-20",
    scheduledFor: "2026-07-20T04:00:00.000+08:00",
    timeZone: "Asia/Shanghai",
    memoryWindow: {
      start: "2026-07-19T04:00:00.000+08:00",
      end: "2026-07-20T04:00:00.000+08:00",
      secret: "extension-secret"
    },
    workingMemories: [memory(
      "working-1",
      "海老师（12345678）完成了承诺，记录在 /Users/tanshow/Developer/sunabot；api_key=super-secret-value。"
    )],
    longTermMemories: [memory("long-1", "海老师曾在旧车站提出同一个长期计划。")],
    recallStats: [{
      recordId: "long-1",
      recallCount: 0,
      distinctRecallDays: 0,
      lastRecalledAt: null,
      trackingStartedAt: "2026-03-01T00:00:00.000Z",
      lastReviewedAt: null,
      importance: 0.8,
      futureRelevance: 0.9,
      emotionalSalience: 0.7,
      secret: "extension-secret"
    }],
    personaEvidenceIds: ["working-1", "long-1", "unknown-id"],
    fieldKnowledgeEvidenceIds: ["working-1", "unknown-id"],
    recentWindowHours: 24,
    sourceMemoryIds: ["working-1", "long-1", "unknown-id"],
    userProfiles: [{
      id: "profile_12345678",
      userId: "12345678",
      userName: "海老师",
      addressNames: ["海老师"],
      fact: "海老师喜欢按因果顺序整理任务。",
      updatedAt: "2026-07-19T20:00:00.000Z",
      arbitrary: "extension-secret"
    }],
    observedConversations: [{
      id: "private:12345678",
      scope: "private",
      title: "海老师",
      messages: [{
        id: "message-secret",
        role: "user",
        text: "海老师说先整理旧车站的计划。",
        at: "2026-07-19T20:30:00.000Z",
        userId: "12345678",
        senderName: "海老师",
        filePath: "/Users/tanshow/secret.txt"
      }, {
        role: "event",
        text: "T 也确认了时间。",
        at: "2026-07-19T20:40:00.000Z",
        userId: "999",
        senderName: "T"
      }],
      arbitrary: "extension-secret"
    }],
    activeTasks: [{
      id: "task-secret-id",
      title: "整理旧车站计划",
      enabled: true,
      status: "running",
      schedule: { kind: "once", runAt: "2026-07-21T09:00:00.000+08:00", arbitrary: "extension-secret" },
      context: "和海老师核对，token=super-secret-value，附件在 /Users/tanshow/task.md。",
      nextRunAt: "2026-07-21T09:00:00.000Z",
      targets: [{ conversationId: "private:12345678", mentionUserIds: ["12345678"], secret: "extension-secret" }],
      arbitrary: "extension-secret"
    }],
    plannedDailySchedule: {
      schemaVersion: 1,
      date: "2026-07-19",
      timeZone: "Asia/Shanghai",
      theme: "兑现承诺",
      summary: "与海老师整理旧车站计划。",
      items: [{
        id: "director-item-secret",
        startAt: "2026-07-19T19:00:00.000+08:00",
        endAt: "2026-07-19T20:00:00.000+08:00",
        activity: "整理计划",
        location: "书房",
        participants: ["海老师"],
        intent: "把因果关系写清楚",
        variant: "quiet",
        share: { enabled: true, at: null, textIntent: "分享进度", selfiePrompt: null, secret: "extension-secret" },
        arbitrary: "extension-secret"
      }],
      secret: "extension-secret"
    },
    personaImpressions: [{
      id: "persona-run-1",
      appliedAt: "2026-07-19T04:05:00.000Z",
      kind: "communication_preference",
      targetFile: "PREFERENCE.md",
      topicKey: "communication.evidence",
      level: "stable",
      statement: "与海老师协作时会重视可核验证据。",
      secret: "extension-secret"
    }],
    persona: {
      id: "plana",
      name: "Plana",
      soul: "Plana 温和、谨慎。",
      preference: "重视清晰和承诺。",
      user: "海老师是长期伙伴。",
      relation: "与海老师保持真诚关系。",
      air: "工作区在 /Users/tanshow/Developer/sunabot，password=super-secret-value。",
      secret: "extension-secret"
    },
    arbitrary: "extension-secret"
  };
}

function oversizedPayload() {
  const raw = sensitivePayload();
  const memory = (prefix: string, index: number) => ({
    ...raw.workingMemories[0]!,
    id: `${prefix}-${index}`,
    memory: {
      ...raw.workingMemories[0]!.memory,
      id: `${prefix}-${index}`,
      fact: `${prefix}-${index}:${"梦".repeat(5_000)}`,
      userId: undefined,
      userIds: [],
      userName: undefined,
      addressNames: []
    }
  });
  raw.workingMemories = Array.from({ length: 100 }, (_, index) => memory("working", index));
  raw.longTermMemories = Array.from({ length: 100 }, (_, index) => memory("long", index));
  raw.sourceMemoryIds = [...raw.workingMemories, ...raw.longTermMemories].map((item) => item.id);
  raw.personaEvidenceIds = [...raw.sourceMemoryIds];
  raw.recallStats = raw.longTermMemories.map((item) => ({
    recordId: item.id,
    recallCount: 0,
    distinctRecallDays: 0,
    lastRecalledAt: null,
    trackingStartedAt: "2026-01-01T00:00:00.000Z",
    lastReviewedAt: null,
    importance: 0,
    futureRelevance: 0,
    emotionalSalience: 0
  }));
  raw.userProfiles = Array.from({ length: 100 }, (_, index) => ({ id: `profile-${index}`, fact: "档".repeat(4_000) }));
  raw.observedConversations = Array.from({ length: 20 }, (_, conversationIndex) => ({
    id: `conversation-${conversationIndex}`,
    messages: Array.from({ length: 30 }, (_, messageIndex) => ({ role: "event", text: "聊".repeat(4_000), at: `${messageIndex}` }))
  }));
  raw.activeTasks = Array.from({ length: 150 }, (_, index) => ({ id: `task-${index}`, title: "任务".repeat(1_000), context: "做".repeat(4_000) }));
  raw.plannedDailySchedule.items = Array.from({ length: 100 }, (_, index) => ({
    id: `item-${index}`,
    activity: "活动".repeat(1_000),
    participants: [],
    share: { enabled: false }
  }));
  raw.persona.soul = "人格".repeat(8_000);
  raw.persona.preference = "偏好".repeat(8_000);
  raw.persona.user = "用户".repeat(8_000);
  raw.persona.relation = "关系".repeat(8_000);
  raw.persona.air = "场域".repeat(8_000);
  return raw;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function objectArray(value: unknown) {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function findForbiddenKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  const record = objectValue(value);
  return Object.entries(record).flatMap(([key, item]) => {
    const current = `${path}.${key}`;
    const forbidden = new Set([
      "secret", "arbitrary", "filePath", "participantRefs", "speakerRef", "profileRef",
      "contextRef", "eventRef", "causalChainRef", "subjectRef", "taskRef", "itemRef",
      "impressionRef", "fieldKnowledgeBindings"
    ]);
    return [...forbidden.has(key) ? [current] : [], ...findForbiddenKeys(item, current)];
  });
}
