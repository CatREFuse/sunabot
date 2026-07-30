import crypto from "node:crypto";
import fs from "node:fs/promises";
import { normalizeDirectorScheduleDraft } from "../../services/director/public.js";
import {
  USER_TEST_CASE_MARKER,
  type DreamDirectorScheduleFixture,
  type UserTestCase,
  type UserTestQualityCriterion
} from "./contracts.js";

export async function readUserTestCaseDocument(filePath: string) {
  const source = await fs.readFile(filePath, "utf8");
  const caseDefinition = parseUserTestCaseDocument(source);
  return {
    case: caseDefinition,
    digest: crypto.createHash("sha256").update(source).digest("hex"),
    source
  };
}

export function parseUserTestCaseDocument(source: string): UserTestCase {
  const markerIndex = source.indexOf(USER_TEST_CASE_MARKER);
  if (markerIndex < 0) throw new Error("USER_TEST_CASE_MARKER_MISSING");
  if (source.indexOf(USER_TEST_CASE_MARKER, markerIndex + USER_TEST_CASE_MARKER.length) >= 0) {
    throw new Error("USER_TEST_CASE_MARKER_DUPLICATE");
  }
  const fenced = source.slice(markerIndex + USER_TEST_CASE_MARKER.length)
    .match(/^[\t ]*```json[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*```/mu);
  if (!fenced?.[1]) throw new Error("USER_TEST_CASE_JSON_MISSING");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]);
  } catch {
    throw new Error("USER_TEST_CASE_JSON_INVALID");
  }
  return validateUserTestCase(parsed);
}

export function replaceUserTestCaseDocumentDefinition(
  source: string,
  nextCase: UserTestCase
) {
  parseUserTestCaseDocument(source);
  const markerIndex = source.indexOf(USER_TEST_CASE_MARKER);
  const afterMarker = source.slice(markerIndex + USER_TEST_CASE_MARKER.length);
  const fenced = afterMarker.match(
    /^([\t ]*```json[\t ]*\r?\n)([\s\S]*?)(\r?\n[\t ]*```)/mu
  );
  if (!fenced || fenced.index == null) throw new Error("USER_TEST_CASE_JSON_MISSING");
  const jsonStart = markerIndex + USER_TEST_CASE_MARKER.length +
    fenced.index + fenced[1]!.length;
  const jsonEnd = jsonStart + fenced[2]!.length;
  const output = `${source.slice(0, jsonStart)}${JSON.stringify(nextCase, null, 2)}${source.slice(jsonEnd)}`;
  parseUserTestCaseDocument(output);
  return output;
}

function validateUserTestCase(value: unknown): UserTestCase {
  const input = record(value, "USER_TEST_CASE_INVALID");
  exactKeys(input, [
    "schemaVersion",
    "id",
    "title",
    "kind",
    "goal",
    "input",
    "expected",
    "quality"
  ]);
  if (input.schemaVersion !== 1) throw new Error("USER_TEST_CASE_VERSION_UNSUPPORTED");
  const kind = input.kind;
  if (kind !== "conversation" && kind !== "memory_compression" && kind !== "dream") {
    throw new Error("USER_TEST_CASE_KIND_INVALID");
  }
  const expected = record(input.expected, "USER_TEST_CASE_EXPECTED_INVALID");
  exactKeys(expected, [
    "requiredTools",
    "forbiddenTools",
    "forbiddenSuccessfulTools",
    "requiredAvailableTools",
    "forbiddenAvailableTools",
    "requiredText",
    "forbiddenText",
    "providerPrompt",
    "requiredOutboundKinds",
    "forbiddenOutboundKinds",
    "requiredInboundAttachments",
    "minimumOutboundCount",
    "maximumOutboundCount"
  ], true);
  const quality = record(input.quality, "USER_TEST_CASE_QUALITY_INVALID");
  exactKeys(quality, ["criteria"]);
  const criteria = array(quality.criteria, "USER_TEST_CASE_QUALITY_INVALID")
    .map(validateQualityCriterion);
  if (!criteria.length || new Set(criteria.map((item) => item.id)).size !== criteria.length) {
    throw new Error("USER_TEST_CASE_QUALITY_INVALID");
  }
  return {
    schemaVersion: 1,
    id: boundedText(input.id, "id", 1, 96, /^[a-z0-9][a-z0-9._-]*$/u),
    title: boundedText(input.title, "title", 1, 200),
    kind,
    goal: boundedText(input.goal, "goal", 1, 2_000),
    input: validateCaseInput(kind, input.input),
    expected: {
      ...optionalStringArray(expected.requiredTools, "requiredTools"),
      ...optionalStringArray(expected.forbiddenTools, "forbiddenTools"),
      ...optionalStringArray(expected.forbiddenSuccessfulTools, "forbiddenSuccessfulTools"),
      ...optionalStringArray(expected.requiredAvailableTools, "requiredAvailableTools"),
      ...optionalStringArray(expected.forbiddenAvailableTools, "forbiddenAvailableTools"),
      ...optionalStringArray(expected.requiredText, "requiredText"),
      ...optionalStringArray(expected.forbiddenText, "forbiddenText"),
      ...optionalProviderPrompt(expected.providerPrompt),
      ...optionalOutboundKindArray(expected.requiredOutboundKinds, "requiredOutboundKinds"),
      ...optionalOutboundKindArray(expected.forbiddenOutboundKinds, "forbiddenOutboundKinds"),
      ...optionalInboundAttachmentArray(expected.requiredInboundAttachments),
      ...optionalCount(expected.minimumOutboundCount, "minimumOutboundCount"),
      ...optionalCount(expected.maximumOutboundCount, "maximumOutboundCount")
    },
    quality: { criteria }
  };
}

function validateCaseInput(kind: UserTestCase["kind"], value: unknown): UserTestCase["input"] {
  const input = record(value, "USER_TEST_CASE_INPUT_INVALID");
  if (kind === "conversation") {
    exactKeys(input, [
      "actor",
      "event",
      "accountId",
      "selfId",
      "replyEnabled",
      "forwardMessages",
      "fixture"
    ], true);
    const actor = input.actor;
    if (!["admin_private", "user_private", "admin_group", "user_group"].includes(String(actor))) {
      throw new Error("USER_TEST_CASE_ACTOR_INVALID");
    }
    return {
      actor: actor as "admin_private" | "user_private" | "admin_group" | "user_group",
      event: record(input.event, "USER_TEST_CASE_EVENT_INVALID"),
      accountId: boundedText(input.accountId, "accountId", 1, 64, /^[A-Za-z0-9_-]+$/u),
      selfId: boundedText(input.selfId, "selfId", 1, 32, /^\d+$/u),
      ...(input.replyEnabled == null ? {} : { replyEnabled: Boolean(input.replyEnabled) }),
      ...(input.forwardMessages == null ? {} : {
        forwardMessages: record(input.forwardMessages, "USER_TEST_CASE_FORWARD_INVALID")
      }),
      ...(input.fixture == null ? {} : {
        fixture: validateConversationFixture(input.fixture)
      })
    };
  }
  if (kind === "dream") {
    exactKeys(input, [
      "timePolicy",
      "now",
      "workingMemory",
      "longTerm",
      "userProfiles",
      "persona",
      "conversations",
      "activeTasks",
      "directorSchedule"
    ]);
    const timePolicy = validateBranchTimePolicy(input.timePolicy);
    const now = boundedText(input.now, "now", 1, 64);
    if (!Number.isFinite(Date.parse(now))) throw new Error("USER_TEST_CASE_NOW_INVALID");
    const workingMemory = validateWorkingMemoryFixture(input.workingMemory);
    const longTerm = validateJsonFixtureRecords(input.longTerm, "LONG_TERM");
    const userProfiles = validateJsonFixtureRecords(input.userProfiles, "USER_PROFILES");
    const persona = validateDreamPersona(input.persona);
    const conversations = array(
      input.conversations,
      "USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID"
    ).map((item, index) => validateDreamConversation(item, index));
    if (!workingMemory.length || !conversations.length) {
      throw new Error("USER_TEST_CASE_DREAM_FIXTURE_EMPTY");
    }
    const activeTasks = array(
      input.activeTasks,
      "USER_TEST_CASE_DREAM_TASKS_INVALID"
    ).map((item, index) => validateDreamTask(item, index, conversations.map(({ id }) => id)));
    const directorSchedule = input.directorSchedule == null
      ? null
      : validateDreamDirectorSchedule(input.directorSchedule);
    return {
      timePolicy,
      now,
      workingMemory,
      longTerm,
      userProfiles,
      persona,
      conversations,
      activeTasks,
      directorSchedule
    };
  }
  exactKeys(input, [
    "timePolicy",
    "now",
    "workingMemory",
    "longTerm",
    "userProfiles",
    "conversation",
    "messages"
  ]);
  const timePolicy = validateBranchTimePolicy(input.timePolicy);
  const now = boundedText(input.now, "now", 1, 64);
  if (!Number.isFinite(Date.parse(now))) throw new Error("USER_TEST_CASE_NOW_INVALID");
  const workingMemory = validateWorkingMemoryFixture(input.workingMemory);
  const longTerm = validateJsonFixtureRecords(input.longTerm, "LONG_TERM");
  const userProfiles = validateJsonFixtureRecords(input.userProfiles, "USER_PROFILES");
  const conversation = record(input.conversation, "USER_TEST_CASE_CONVERSATION_INVALID");
  exactKeys(conversation, ["id", "scope", "title", "userId", "groupId"], true);
  if (!["private", "user_group", "bot_group"].includes(String(conversation.scope))) {
    throw new Error("USER_TEST_CASE_CONVERSATION_INVALID");
  }
  const messages = array(input.messages, "USER_TEST_CASE_MESSAGES_INVALID").map((item, index) => {
    const message = record(item, "USER_TEST_CASE_MESSAGES_INVALID");
    exactKeys(message, [
      "id", "sequence", "role", "text", "at", "userId", "senderName", "imageCount", "quoteCount"
    ], true);
    const role = message.role;
    if (role !== "user" && role !== "assistant") throw new Error("USER_TEST_CASE_MESSAGES_INVALID");
    return {
      id: boundedText(message.id, `messages[${index}].id`, 1, 128),
      sequence: positiveInteger(message.sequence, `messages[${index}].sequence`),
      role,
      text: boundedText(message.text, `messages[${index}].text`, 1, 20_000),
      at: isoTimestamp(message.at, `messages[${index}].at`),
      ...(message.userId == null ? {} : { userId: positiveInteger(message.userId, "userId") }),
      ...(message.senderName == null ? {} : { senderName: boundedText(message.senderName, "senderName", 1, 200) }),
      ...(message.imageCount == null ? {} : { imageCount: nonNegativeInteger(message.imageCount, "imageCount") }),
      ...(message.quoteCount == null ? {} : { quoteCount: nonNegativeInteger(message.quoteCount, "quoteCount") })
    };
  });
  if (!messages.length) throw new Error("USER_TEST_CASE_MESSAGES_INVALID");
  return {
    timePolicy,
    now,
    workingMemory,
    longTerm,
    userProfiles,
    conversation: {
      id: boundedText(conversation.id, "conversation.id", 1, 200),
      scope: conversation.scope as "private" | "user_group" | "bot_group",
      title: boundedText(conversation.title, "conversation.title", 1, 200),
      ...(conversation.userId == null ? {} : { userId: positiveInteger(conversation.userId, "userId") }),
      ...(conversation.groupId == null ? {} : { groupId: positiveInteger(conversation.groupId, "groupId") })
    },
    messages
  };
}

function validateBranchTimePolicy(value: unknown) {
  if (value !== "fixed" && value !== "rebase_to_runtime") {
    throw new Error("USER_TEST_CASE_TIME_POLICY_INVALID");
  }
  return value;
}

function validateConversationFixture(value: unknown) {
  const fixture = record(value, "USER_TEST_CASE_CONVERSATION_FIXTURE_INVALID");
  exactKeys(fixture, [
    "workingMemory",
    "longTerm",
    "userProfiles",
    "air",
    "resetKnowledge",
    "workbenchFiles",
    "attachmentSources",
    "conversationMessages"
  ], true);
  const resetKnowledge = fixture.resetKnowledge == null
    ? undefined
    : array(
        fixture.resetKnowledge,
        "USER_TEST_CASE_CONVERSATION_FIXTURE_RESET_KNOWLEDGE_INVALID"
      ).map((backend) => {
        if (backend !== "native" && backend !== "docker") {
          throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_RESET_KNOWLEDGE_INVALID");
        }
        return backend;
      });
  if (
    resetKnowledge &&
    (resetKnowledge.length > 2 || new Set(resetKnowledge).size !== resetKnowledge.length)
  ) {
    throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_RESET_KNOWLEDGE_INVALID");
  }
  const files = fixture.workbenchFiles == null
    ? undefined
    : array(
        fixture.workbenchFiles,
        "USER_TEST_CASE_CONVERSATION_FIXTURE_FILES_INVALID"
      ).map((item, index) => {
        const file = record(item, "USER_TEST_CASE_CONVERSATION_FIXTURE_FILES_INVALID");
        exactKeys(file, ["backend", "path", "content"]);
        if (file.backend !== "native" && file.backend !== "docker") {
          throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_BACKEND_INVALID");
        }
        const relativePath = boundedText(
          file.path,
          `fixture.workbenchFiles[${index}].path`,
          1,
          256
        );
        const segments = relativePath.split("/");
        if (
          relativePath.startsWith("/") ||
          relativePath.includes("\\") ||
          segments.some((segment) => !segment || segment === "." || segment === "..")
        ) {
          throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_PATH_INVALID");
        }
        return {
          backend: file.backend,
          path: relativePath,
          content: boundedRawText(
            file.content,
            `fixture.workbenchFiles[${index}].content`,
            1_000_000
          )
        };
      });
  if (files && files.length > 64) {
    throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_FILES_INVALID");
  }
  const attachmentSources = fixture.attachmentSources == null
    ? undefined
    : array(
        fixture.attachmentSources,
        "USER_TEST_CASE_CONVERSATION_FIXTURE_ATTACHMENTS_INVALID"
      ).map((item, index) => {
        const source = record(
          item,
          "USER_TEST_CASE_CONVERSATION_FIXTURE_ATTACHMENTS_INVALID"
        );
        exactKeys(source, ["fileId", "name", "contentBase64"]);
        const fileId = boundedText(
          source.fileId,
          `fixture.attachmentSources[${index}].fileId`,
          1,
          2_048
        );
        if (/^(?:data:|base64:\/\/|https?:\/\/|file:)/iu.test(fileId)) {
          throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_ATTACHMENT_ID_INVALID");
        }
        const contentBase64 = boundedText(
          source.contentBase64,
          `fixture.attachmentSources[${index}].contentBase64`,
          4,
          1_500_000,
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        );
        const content = Buffer.from(contentBase64, "base64");
        if (
          content.length === 0 ||
          content.length > 1_000_000 ||
          content.toString("base64") !== contentBase64
        ) {
          throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_ATTACHMENT_BASE64_INVALID");
        }
        return {
          fileId,
          name: boundedText(
            source.name,
            `fixture.attachmentSources[${index}].name`,
            1,
            180
          ),
          contentBase64
        };
      });
  if (
    attachmentSources &&
    (
      attachmentSources.length > 4 ||
      new Set(attachmentSources.map((item) => item.fileId)).size !== attachmentSources.length
    )
  ) {
    throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_ATTACHMENTS_INVALID");
  }
  const conversationMessages = fixture.conversationMessages == null
    ? undefined
    : validateConversationFixtureMessages(fixture.conversationMessages);
  return {
    ...(fixture.workingMemory == null ? {} : {
      workingMemory: validateWorkingMemoryFixture(fixture.workingMemory)
    }),
    ...(fixture.longTerm == null ? {} : {
      longTerm: validateJsonFixtureRecords(fixture.longTerm, "LONG_TERM")
    }),
    ...(fixture.userProfiles == null ? {} : {
      userProfiles: validateJsonFixtureRecords(fixture.userProfiles, "USER_PROFILES")
    }),
    ...(fixture.air == null ? {} : {
      air: boundedText(fixture.air, "fixture.air", 1, 64 * 1_024)
    }),
    ...(resetKnowledge == null ? {} : { resetKnowledge }),
    ...(files == null ? {} : { workbenchFiles: files }),
    ...(attachmentSources == null ? {} : { attachmentSources }),
    ...(conversationMessages == null ? {} : { conversationMessages })
  };
}

function validateConversationFixtureMessages(value: unknown) {
  const messages = array(
    value,
    "USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID"
  ).map((item, index) => {
    const message = record(
      item,
      "USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID"
    );
    exactKeys(message, [
      "id",
      "sequence",
      "role",
      "text",
      "at",
      "userId",
      "senderName"
    ], true);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID");
    }
    if (message.sequence !== index + 1) {
      throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID");
    }
    if (message.role === "user" && message.userId == null) {
      throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID");
    }
    return {
      id: boundedText(
        message.id,
        `fixture.conversationMessages[${index}].id`,
        1,
        128,
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
      ),
      sequence: positiveInteger(
        message.sequence,
        `fixture.conversationMessages[${index}].sequence`
      ),
      role: message.role,
      text: boundedText(
        message.text,
        `fixture.conversationMessages[${index}].text`,
        1,
        20_000
      ),
      at: isoTimestamp(
        message.at,
        `fixture.conversationMessages[${index}].at`
      ),
      ...(message.userId == null ? {} : {
        userId: positiveInteger(
          message.userId,
          `fixture.conversationMessages[${index}].userId`
        )
      }),
      ...(message.senderName == null ? {} : {
        senderName: boundedText(
          message.senderName,
          `fixture.conversationMessages[${index}].senderName`,
          1,
          200
        )
      })
    };
  });
  if (
    messages.length === 0 ||
    messages.length > 120 ||
    new Set(messages.map((message) => message.id)).size !== messages.length
  ) {
    throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID");
  }
  for (let index = 1; index < messages.length; index += 1) {
    if (Date.parse(messages[index]!.at) <= Date.parse(messages[index - 1]!.at)) {
      throw new Error("USER_TEST_CASE_CONVERSATION_FIXTURE_MESSAGES_INVALID");
    }
  }
  return messages;
}

function validateWorkingMemoryFixture(value: unknown) {
  return array(
    value,
    "USER_TEST_CASE_WORKING_MEMORY_INVALID"
  ).map((item, index) => {
    const memory = record(item, "USER_TEST_CASE_WORKING_MEMORY_INVALID");
    exactKeys(memory, [
      "id",
      "content",
      "occurredAt",
      "recordedAt",
      "timeZone",
      "conversationId",
      "conversationScope",
      "conversationTitle",
      "sourceKind",
      "batchId",
      "userId",
      "userIds",
      "userName",
      "addressNames",
      "occurredEndAt",
      "eventType",
      "subjectKey",
      "eventKey",
      "causalChainKey",
      "sourceMemoryIds",
      "memoryKind",
      "realityStatus",
      "factuality",
      "dreamRunId",
      "dreamDate",
      "dreamReviewedAt"
    ], true);
    if (!["private", "user_group", "bot_group"].includes(String(memory.conversationScope))) {
      throw new Error("USER_TEST_CASE_WORKING_MEMORY_INVALID");
    }
    if (
      memory.sourceKind != null &&
      !["model_merge", "add_workmemory", "admin", "dream"].includes(String(memory.sourceKind))
    ) {
      throw new Error("USER_TEST_CASE_WORKING_MEMORY_INVALID");
    }
    const occurredAt = isoTimestamp(memory.occurredAt, `workingMemory[${index}].occurredAt`);
    return {
      id: boundedText(
        memory.id,
        `workingMemory[${index}].id`,
        1,
        128,
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/u
      ),
      content: boundedText(memory.content, `workingMemory[${index}].content`, 1, 4_000),
      occurredAt,
      ...(memory.recordedAt == null ? {} : {
        recordedAt: isoTimestamp(memory.recordedAt, `workingMemory[${index}].recordedAt`)
      }),
      ...(memory.timeZone == null ? {} : {
        timeZone: boundedText(memory.timeZone, `workingMemory[${index}].timeZone`, 1, 80)
      }),
      conversationId: boundedText(
        memory.conversationId,
        `workingMemory[${index}].conversationId`,
        1,
        256
      ),
      conversationScope: memory.conversationScope as "private" | "user_group" | "bot_group",
      ...(memory.conversationTitle == null ? {} : {
        conversationTitle: boundedText(
          memory.conversationTitle,
          `workingMemory[${index}].conversationTitle`,
          1,
          500
        )
      }),
      ...(memory.sourceKind == null ? {} : {
        sourceKind: memory.sourceKind as "model_merge" | "add_workmemory" | "admin" | "dream"
      }),
      ...optionalFixtureText(memory.batchId, "batchId", 256),
      ...optionalFixtureText(memory.userId, "userId", 64),
      ...optionalFixtureStringArray(memory.userIds, "userIds", 64),
      ...optionalFixtureText(memory.userName, "userName", 200),
      ...optionalFixtureStringArray(memory.addressNames, "addressNames", 200),
      ...(memory.occurredEndAt == null ? {} : {
        occurredEndAt: isoTimestamp(memory.occurredEndAt, `workingMemory[${index}].occurredEndAt`)
      }),
      ...optionalFixtureText(memory.eventType, "eventType", 100),
      ...optionalFixtureText(memory.subjectKey, "subjectKey", 200),
      ...optionalFixtureText(memory.eventKey, "eventKey", 256),
      ...optionalFixtureText(memory.causalChainKey, "causalChainKey", 256),
      ...optionalFixtureStringArray(memory.sourceMemoryIds, "sourceMemoryIds", 128),
      ...optionalFixtureText(memory.memoryKind, "memoryKind", 64),
      ...optionalFixtureText(memory.realityStatus, "realityStatus", 64),
      ...optionalFixtureText(memory.factuality, "factuality", 64),
      ...optionalFixtureText(memory.dreamRunId, "dreamRunId", 128),
      ...optionalFixtureText(memory.dreamDate, "dreamDate", 32),
      ...(memory.dreamReviewedAt == null ? {} : {
        dreamReviewedAt: isoTimestamp(
          memory.dreamReviewedAt,
          `workingMemory[${index}].dreamReviewedAt`
        )
      })
    };
  });
}

function validateDreamPersona(value: unknown) {
  const persona = record(value, "USER_TEST_CASE_DREAM_PERSONA_INVALID");
  exactKeys(persona, ["name", "soul", "preference", "user", "relation", "air"]);
  return {
    name: boundedText(persona.name, "persona.name", 1, 120),
    soul: boundedEmptyText(persona.soul, "persona.soul", 32_000),
    preference: boundedEmptyText(persona.preference, "persona.preference", 32_000),
    user: boundedEmptyText(persona.user, "persona.user", 32_000),
    relation: boundedEmptyText(persona.relation, "persona.relation", 32_000),
    air: boundedEmptyText(persona.air, "persona.air", 32_000)
  };
}

function validateDreamTask(value: unknown, index: number, conversationIds: readonly string[]) {
  const task = record(value, "USER_TEST_CASE_DREAM_TASKS_INVALID");
  exactKeys(task, [
    "id",
    "name",
    "runAt",
    "context",
    "targetConversationId",
    "mentionUserIds"
  ]);
  const targetConversationId = boundedText(
    task.targetConversationId,
    `activeTasks[${index}].targetConversationId`,
    1,
    256
  );
  if (!conversationIds.includes(targetConversationId)) {
    throw new Error("USER_TEST_CASE_DREAM_TASK_TARGET_INVALID");
  }
  return {
    id: boundedText(
      task.id,
      `activeTasks[${index}].id`,
      1,
      128,
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/u
    ),
    name: boundedText(task.name, `activeTasks[${index}].name`, 1, 120),
    runAt: isoTimestamp(task.runAt, `activeTasks[${index}].runAt`),
    context: boundedEmptyText(task.context, `activeTasks[${index}].context`, 32_768),
    targetConversationId,
    mentionUserIds: optionalFixtureStringArray(
      task.mentionUserIds,
      "mentionUserIds",
      32,
      /^\d+$/u
    ).mentionUserIds ?? []
  };
}

function validateDreamDirectorSchedule(value: unknown): DreamDirectorScheduleFixture {
  const schedule = record(value, "USER_TEST_CASE_DREAM_DIRECTOR_INVALID");
  const date = boundedText(schedule.date, "directorSchedule.date", 10, 10);
  const timeZone = boundedText(schedule.timeZone, "directorSchedule.timeZone", 1, 80);
  try {
    return normalizeDirectorScheduleDraft(schedule, { date, timeZone });
  } catch {
    throw new Error("USER_TEST_CASE_DREAM_DIRECTOR_INVALID");
  }
}

function validateJsonFixtureRecords(value: unknown, field: string) {
  const records = array(value, `USER_TEST_CASE_${field}_INVALID`);
  if (records.length > 256) throw new Error(`USER_TEST_CASE_${field}_INVALID`);
  let totalBytes = 0;
  const output = records.map((item) => {
    const next = validateJsonFixtureValue(item, field, 0);
    const encoded = JSON.stringify(next);
    totalBytes += Buffer.byteLength(encoded);
    return next as Record<string, unknown>;
  });
  if (totalBytes > 512 * 1024) throw new Error(`USER_TEST_CASE_${field}_INVALID`);
  return output;
}

function validateJsonFixtureValue(value: unknown, field: string, depth: number): unknown {
  if (depth > 12) throw new Error(`USER_TEST_CASE_${field}_INVALID`);
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`USER_TEST_CASE_${field}_INVALID`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 32_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
      throw new Error(`USER_TEST_CASE_${field}_INVALID`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error(`USER_TEST_CASE_${field}_INVALID`);
    return value.map((item) => validateJsonFixtureValue(item, field, depth + 1));
  }
  const object = record(value, `USER_TEST_CASE_${field}_INVALID`);
  const entries = Object.entries(object);
  if (entries.length > 256) throw new Error(`USER_TEST_CASE_${field}_INVALID`);
  return Object.fromEntries(entries.map(([key, item]) => {
    if (
      !key ||
      key.length > 128 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      throw new Error(`USER_TEST_CASE_${field}_INVALID`);
    }
    return [key, validateJsonFixtureValue(item, field, depth + 1)];
  }));
}

function validateDreamConversation(value: unknown, index: number) {
  const conversation = record(value, "USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID");
  exactKeys(conversation, ["id", "scope", "title", "userId", "groupId", "messages"], true);
  if (!["private", "user_group", "bot_group"].includes(String(conversation.scope))) {
    throw new Error("USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID");
  }
  const messages = array(
    conversation.messages,
    "USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID"
  ).map((item, messageIndex) => {
    const message = record(item, "USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID");
    exactKeys(message, ["id", "sequence", "role", "text", "at", "userId", "senderName"], true);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error("USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID");
    }
    return {
      id: boundedText(message.id, `conversations[${index}].messages[${messageIndex}].id`, 1, 128),
      sequence: positiveInteger(
        message.sequence,
        `conversations[${index}].messages[${messageIndex}].sequence`
      ),
      role: message.role,
      text: boundedText(
        message.text,
        `conversations[${index}].messages[${messageIndex}].text`,
        1,
        20_000
      ),
      at: isoTimestamp(
        message.at,
        `conversations[${index}].messages[${messageIndex}].at`
      ),
      ...(message.userId == null ? {} : {
        userId: positiveInteger(message.userId, "userId")
      }),
      ...(message.senderName == null ? {} : {
        senderName: boundedText(message.senderName, "senderName", 1, 200)
      })
    };
  });
  if (!messages.length) throw new Error("USER_TEST_CASE_DREAM_CONVERSATIONS_INVALID");
  return {
    id: boundedText(conversation.id, `conversations[${index}].id`, 1, 200),
    scope: conversation.scope as "private" | "user_group" | "bot_group",
    title: boundedText(conversation.title, `conversations[${index}].title`, 1, 200),
    userId: positiveInteger(conversation.userId, `conversations[${index}].userId`),
    ...(conversation.groupId == null ? {} : {
      groupId: positiveInteger(conversation.groupId, `conversations[${index}].groupId`)
    }),
    messages
  };
}

function validateQualityCriterion(value: unknown): UserTestQualityCriterion {
  const criterion = record(value, "USER_TEST_CASE_QUALITY_INVALID");
  exactKeys(criterion, ["id", "description", "minimumScore"]);
  const minimumScore = Number(criterion.minimumScore);
  if (!Number.isInteger(minimumScore) || minimumScore < 1 || minimumScore > 5) {
    throw new Error("USER_TEST_CASE_QUALITY_INVALID");
  }
  return {
    id: boundedText(criterion.id, "criterion.id", 1, 64, /^[a-z0-9][a-z0-9._-]*$/u),
    description: boundedText(criterion.description, "criterion.description", 1, 1_000),
    minimumScore
  };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: string[], optional = false) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("USER_TEST_CASE_EXTRA_FIELD");
  if (!optional && keys.some((key) => !(key in value))) throw new Error("USER_TEST_CASE_FIELD_MISSING");
}

function boundedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  pattern?: RegExp
) {
  if (typeof value !== "string") throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum || (pattern && !pattern.test(text))) {
    throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  }
  return text;
}

function boundedEmptyText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  }
  return value.trim();
}

function boundedRawText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function optionalFixtureText(value: unknown, key: string, maximum: number) {
  return value == null ? {} : { [key]: boundedText(value, key, 1, maximum) };
}

function optionalFixtureStringArray(
  value: unknown,
  key: string,
  maximum: number,
  pattern?: RegExp
): Record<string, string[]> {
  if (value == null) return {};
  const items = array(value, `USER_TEST_CASE_${key.toUpperCase()}_INVALID`)
    .map((item) => boundedText(item, key, 1, maximum, pattern));
  if (items.length > 64) throw new Error(`USER_TEST_CASE_${key.toUpperCase()}_INVALID`);
  return { [key]: [...new Set(items)] };
}

function optionalStringArray(value: unknown, key: string) {
  if (value == null) return {};
  const items = array(value, `USER_TEST_CASE_${key.toUpperCase()}_INVALID`)
    .map((item) => boundedText(item, key, 1, 500));
  return { [key]: [...new Set(items)] };
}

function optionalProviderPrompt(value: unknown) {
  if (value == null) return {};
  const expectation = record(value, "USER_TEST_CASE_PROVIDER_PROMPT_INVALID");
  exactKeys(expectation, ["promptFamily", "orderedText", "forbiddenText"], true);
  const orderedText = array(
    expectation.orderedText,
    "USER_TEST_CASE_PROVIDER_PROMPT_INVALID"
  ).map((item, index) => boundedText(
    item,
    `providerPrompt.orderedText[${index}]`,
    1,
    500
  ));
  const forbiddenText = expectation.forbiddenText == null
    ? undefined
    : array(
        expectation.forbiddenText,
        "USER_TEST_CASE_PROVIDER_PROMPT_INVALID"
      ).map((item, index) => boundedText(
        item,
        `providerPrompt.forbiddenText[${index}]`,
        1,
        500
      ));
  if (
    orderedText.length === 0 ||
    orderedText.length > 64 ||
    new Set(orderedText).size !== orderedText.length ||
    (forbiddenText?.length ?? 0) > 64 ||
    (forbiddenText && new Set(forbiddenText).size !== forbiddenText.length) ||
    forbiddenText?.some((item) => orderedText.includes(item))
  ) {
    throw new Error("USER_TEST_CASE_PROVIDER_PROMPT_INVALID");
  }
  return {
    providerPrompt: {
      promptFamily: boundedText(
        expectation.promptFamily,
        "providerPrompt.promptFamily",
        1,
        120,
        /^[a-z][a-z0-9.-]*$/u
      ),
      orderedText,
      ...(forbiddenText == null ? {} : { forbiddenText })
    }
  };
}

function optionalOutboundKindArray(value: unknown, key: string) {
  if (value == null) return {};
  const items = array(value, `USER_TEST_CASE_${key.toUpperCase()}_INVALID`);
  if (items.some((item) => item !== "message" && item !== "asset" && item !== "poke")) {
    throw new Error(`USER_TEST_CASE_${key.toUpperCase()}_INVALID`);
  }
  return { [key]: [...new Set(items)] };
}

function optionalInboundAttachmentArray(value: unknown) {
  if (value == null) return {};
  const attachments = array(
    value,
    "USER_TEST_CASE_REQUIRED_INBOUND_ATTACHMENTS_INVALID"
  ).map((item, index) => {
    const attachment = record(
      item,
      "USER_TEST_CASE_REQUIRED_INBOUND_ATTACHMENTS_INVALID"
    );
    exactKeys(attachment, [
      "messageId",
      "index",
      "name",
      "status",
      "acquisitionStatus",
      "parseStatus",
      "blobSha256",
      "blobSizeBytes",
      "blobMimeType",
      "format",
      "mimeType",
      "sizeBytes",
      "sha256",
      "pageCount",
      "handle"
    ], true);
    if (!["ready", "partial", "unsupported", "too_large", "failed"].includes(String(attachment.status))) {
      throw new Error("USER_TEST_CASE_REQUIRED_INBOUND_ATTACHMENT_STATUS_INVALID");
    }
    if (
      attachment.acquisitionStatus != null
      && !["pending", "acquired", "failed"].includes(String(attachment.acquisitionStatus))
    ) {
      throw new Error("USER_TEST_CASE_REQUIRED_INBOUND_ATTACHMENT_ACQUISITION_INVALID");
    }
    if (
      attachment.parseStatus != null
      && !["not_started", "pending", "ready", "partial", "unsupported", "parse_failed"]
        .includes(String(attachment.parseStatus))
    ) {
      throw new Error("USER_TEST_CASE_REQUIRED_INBOUND_ATTACHMENT_PARSE_INVALID");
    }
    return {
      messageId: boundedText(
        attachment.messageId,
        `requiredInboundAttachments[${index}].messageId`,
        1,
        128
      ),
      index: nonNegativeInteger(
        attachment.index,
        `requiredInboundAttachments[${index}].index`
      ),
      name: boundedText(
        attachment.name,
        `requiredInboundAttachments[${index}].name`,
        1,
        180
      ),
      status: attachment.status,
      ...(attachment.acquisitionStatus == null ? {} : {
        acquisitionStatus: attachment.acquisitionStatus
      }),
      ...(attachment.parseStatus == null ? {} : {
        parseStatus: attachment.parseStatus
      }),
      ...(attachment.blobSha256 == null ? {} : {
        blobSha256: boundedText(
          attachment.blobSha256,
          `requiredInboundAttachments[${index}].blobSha256`,
          64,
          64,
          /^[a-f0-9]{64}$/u
        )
      }),
      ...(attachment.blobSizeBytes == null ? {} : {
        blobSizeBytes: nonNegativeInteger(
          attachment.blobSizeBytes,
          `requiredInboundAttachments[${index}].blobSizeBytes`
        )
      }),
      ...(attachment.blobMimeType == null ? {} : {
        blobMimeType: boundedText(
          attachment.blobMimeType,
          `requiredInboundAttachments[${index}].blobMimeType`,
          1,
          128
        )
      }),
      ...(attachment.format == null ? {} : {
        format: boundedText(
          attachment.format,
          `requiredInboundAttachments[${index}].format`,
          1,
          32
        )
      }),
      ...(attachment.mimeType == null ? {} : {
        mimeType: boundedText(
          attachment.mimeType,
          `requiredInboundAttachments[${index}].mimeType`,
          1,
          128
        )
      }),
      ...(attachment.sizeBytes == null ? {} : {
        sizeBytes: nonNegativeInteger(
          attachment.sizeBytes,
          `requiredInboundAttachments[${index}].sizeBytes`
        )
      }),
      ...(attachment.sha256 == null ? {} : {
        sha256: boundedText(
          attachment.sha256,
          `requiredInboundAttachments[${index}].sha256`,
          64,
          64,
          /^[a-f0-9]{64}$/u
        )
      }),
      ...(attachment.pageCount == null ? {} : {
        pageCount: nonNegativeInteger(
          attachment.pageCount,
          `requiredInboundAttachments[${index}].pageCount`
        )
      }),
      ...(attachment.handle == null ? {} : {
        handle: boundedText(
          attachment.handle,
          `requiredInboundAttachments[${index}].handle`,
          1,
          256,
          /^message:[^:]+:file:\d+$/u
        )
      })
    };
  });
  if (attachments.length > 4) {
    throw new Error("USER_TEST_CASE_REQUIRED_INBOUND_ATTACHMENTS_INVALID");
  }
  return { requiredInboundAttachments: attachments };
}

function optionalCount(value: unknown, key: string) {
  return value == null ? {} : { [key]: nonNegativeInteger(value, key) };
}

function positiveInteger(value: unknown, field: string) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer <= 0) throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  return integer;
}

function nonNegativeInteger(value: unknown, field: string) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 0) throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  return integer;
}

function isoTimestamp(value: unknown, field: string) {
  const text = boundedText(value, field, 1, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`USER_TEST_CASE_${field.toUpperCase()}_INVALID`);
  return text;
}
