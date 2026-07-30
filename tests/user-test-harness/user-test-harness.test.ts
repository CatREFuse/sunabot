import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { defaultConfig } from "../../src/config.js";
import {
  renderWorkingMemoryMarkdown
} from "../../services/memory/workingMemoryDocument.js";
import {
  parseUserTestCaseDocument,
  readUserTestCaseDocument
} from "../../tooling/user-test-harness/caseDocument.js";
import { USER_TEST_CASE_MARKER, type UserTestCase } from "../../tooling/user-test-harness/contracts.js";
import { RecordingMessagingPort } from "../../tooling/user-test-harness/recordingMessagingPort.js";
import {
  evaluateHarnessAssertions,
  evaluateProviderEvidence,
  extractCalledToolNames,
  extractConversationUserFacingTextValues,
  extractProviderToolCatalog,
  extractToolCallObservations,
  validateConversationActor
} from "../../tooling/user-test-harness/assertions.js";
import { validateAndSealUserTestReport } from "../../tooling/user-test-harness/review.js";
import { sampleBranchFixture } from "../../tooling/user-test-harness/sample.js";
import {
  prepareUserTestWorkspace,
  resetUserTestKnowledgeDirectory
} from "../../tooling/user-test-harness/workspace.js";
import { appendMarkdownReport } from "../../tooling/user-test-harness/markdownReport.js";
import { gateUserTestReleaseManifest } from "../../tooling/user-test-harness/releaseGate.js";
import { deriveBranchCaseFromSample } from "../../tooling/user-test-harness/deriveBranchCase.js";
import {
  materializeDreamAtRuntime,
  materializeMemoryCompressionAtRuntime,
  rebaseDreamTemplateToFixture
} from "../../tooling/user-test-harness/timeline.js";

describe("user test harness", () => {
  it("parses a strict executable case from its required Markdown document", () => {
    const testCase = conversationCase("admin_private", "private", 10001);
    const parsed = parseUserTestCaseDocument([
      "# Admin private tool case",
      "",
      "This document defines the expected user outcome.",
      "",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(testCase),
      "```"
    ].join("\n"));

    expect(parsed).toEqual(testCase);
  });

  it("validates bounded conversation state fixtures and rejects workbench traversal", () => {
    const testCase = conversationCase("admin_private", "private", 10001);
    if (testCase.kind !== "conversation") throw new Error("conversation case required");
    testCase.input.fixture = {
      workingMemory: [],
      longTerm: [],
      userProfiles: [],
      resetKnowledge: ["native", "docker"],
      workbenchFiles: [{
        backend: "native",
        path: "tool-fixtures/input.txt",
        content: "fixture input\n"
      }],
      attachmentSources: [{
        fileId: "fixture-file-id",
        name: "fixture.pdf",
        contentBase64: "JVBERi0xLjQK"
      }]
    };
    testCase.expected.requiredInboundAttachments = [{
      messageId: "99",
      index: 0,
      name: "fixture.pdf",
      status: "ready",
      acquisitionStatus: "acquired",
      parseStatus: "ready",
      blobSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blobSizeBytes: 9,
      blobMimeType: "application/pdf",
      format: "pdf",
      sizeBytes: 9,
      handle: "message:99:file:0"
    }];
    const document = (definition: UserTestCase) => [
      "# Conversation fixture",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(definition),
      "```"
    ].join("\n");
    expect(parseUserTestCaseDocument(document(testCase))).toEqual(testCase);

    const traversal = structuredClone(testCase);
    if (traversal.kind !== "conversation" || !traversal.input.fixture?.workbenchFiles) {
      throw new Error("conversation fixture required");
    }
    traversal.input.fixture.workbenchFiles[0]!.path = "../outside.txt";
    expect(() => parseUserTestCaseDocument(document(traversal)))
      .toThrow("USER_TEST_CASE_CONVERSATION_FIXTURE_PATH_INVALID");

    const duplicateReset = structuredClone(testCase);
    if (duplicateReset.kind !== "conversation" || !duplicateReset.input.fixture) {
      throw new Error("conversation fixture required");
    }
    duplicateReset.input.fixture.resetKnowledge = ["native", "native"];
    expect(() => parseUserTestCaseDocument(document(duplicateReset)))
      .toThrow("USER_TEST_CASE_CONVERSATION_FIXTURE_RESET_KNOWLEDGE_INVALID");

    const invalidBase64 = structuredClone(testCase);
    if (invalidBase64.kind !== "conversation" || !invalidBase64.input.fixture?.attachmentSources) {
      throw new Error("conversation attachment fixture required");
    }
    invalidBase64.input.fixture.attachmentSources[0]!.contentBase64 = "not-base64";
    expect(() => parseUserTestCaseDocument(document(invalidBase64)))
      .toThrow("USER_TEST_CASE_FIXTURE.ATTACHMENTSOURCES[0].CONTENTBASE64_INVALID");
  });

  it.each([
    ["admin_private", "private", 10001, undefined],
    ["user_private", "private", 20002, undefined],
    ["admin_group", "group", 10001, 30003],
    ["user_group", "group", 20002, 30003]
  ] as const)("validates the %s actor and environment", (actor, messageType, userId, groupId) => {
    const testCase = conversationCase(actor, messageType, userId, groupId);
    expect(validateConversationActor(testCase, "10001").every((item) => item.passed)).toBe(true);
  });

  it.each([
    ["admin_private", "private", 10001, undefined, "private"],
    ["user_private", "private", 20002, undefined, "private"],
    ["admin_group", "group", 10001, 30003, "user_group"],
    ["user_group", "group", 20002, 30003, "user_group"]
  ] as const)(
    "routes the %s fixture through the production OneBot parser and delegate",
    async (_actor, messageType, userId, groupId, expectedScope) => {
    const handleInboundMessage = vi.fn(async () => undefined);
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage }
    );
    const transport = new RecordingMessagingPort({ accountId: "primary", selfId: "40004" });

    const inbound = await gateway.ingestEvent({
      post_type: "message",
      message_type: messageType,
      message_id: 99,
      self_id: 40004,
      user_id: userId,
      ...(groupId == null ? {} : { group_id: groupId }),
      time: 1_788_000_000,
      sender: { nickname: "admin" },
      message: [{ type: "text", data: { text: "请使用工具完成任务" } }],
      raw_message: "请使用工具完成任务"
    }, {
      accountId: "primary",
      selfId: "40004"
    }, { transport });

    expect(inbound).toMatchObject({
      accountId: "primary",
      scope: expectedScope,
      messageId: 99,
      userId,
      text: "请使用工具完成任务"
    });
    expect(handleInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 99 }),
      transport,
      { accountId: "primary", selfId: "40004" }
    );
    await gateway.close();
    }
  );

  it("binds attachment fixtures to the declared OneBot account", async () => {
    const transport = new RecordingMessagingPort({
      accountId: "fixture-secondary",
      selfId: "40004",
      attachmentSources: [{
        fileId: "fixture-private-pdf",
        name: "fixture.pdf",
        contentBase64: "JVBERi0xLjQK"
      }]
    });

    await expect(transport.resolveAttachment({
      accountId: "fixture-secondary",
      fileId: "fixture-private-pdf",
      file: "fixture.pdf"
    })).resolves.toEqual({
      kind: "base64",
      base64: "JVBERi0xLjQK",
      via: "file_content"
    });
    await expect(transport.resolveAttachment({
      accountId: "primary",
      fileId: "fixture-private-pdf",
      file: "fixture.pdf"
    })).rejects.toThrow("USER_TEST_ATTACHMENT_ACCOUNT_MISMATCH");
    expect(transport.attachmentResolutionCalls).toEqual([
      expect.objectContaining({
        accountId: "fixture-secondary",
        fileId: "fixture-private-pdf",
        strategy: "resolve",
        outcome: "resolved"
      }),
      expect.objectContaining({
        accountId: "primary",
        fileId: "fixture-private-pdf",
        strategy: "resolve",
        outcome: "account_mismatch"
      })
    ]);
  });

  it("requires explicit Dream working-memory and conversation fixtures", () => {
    const testCase: UserTestCase = {
      schemaVersion: 1,
      id: "dream.explicit-input",
      title: "Dream explicit input",
      kind: "dream",
      goal: "Dream uses the supplied working memory and daily conversation.",
      input: {
        timePolicy: "rebase_to_runtime",
        now: "2026-07-26T12:00:00.000+08:00",
        workingMemory: [{
          id: "working_fixture_1",
          content: "The administrator is preparing a release.",
          occurredAt: "2026-07-26T06:00:00.000+08:00",
          conversationId: "private:10001",
          conversationScope: "private",
          conversationTitle: "Administrator"
        }],
        longTerm: [],
        userProfiles: [],
        persona: {
          name: "Fixture Agent",
          soul: "Grounded fixture persona.",
          preference: "",
          user: "",
          relation: "",
          air: ""
        },
        conversations: [{
          id: "private:10001",
          scope: "private",
          title: "Administrator",
          userId: 10001,
          messages: [{
            id: "message-1",
            sequence: 1,
            role: "user",
            text: "We finished the release checklist.",
            at: "2026-07-26T07:00:00.000+08:00",
            userId: 10001,
            senderName: "Administrator"
          }]
        }],
        activeTasks: [],
        directorSchedule: null
      },
      expected: {},
      quality: {
        criteria: [{
          id: "grounding",
          description: "The Dream is grounded in the fixture.",
          minimumScore: 4
        }]
      }
    };
    const parsed = parseUserTestCaseDocument([
      "# Dream",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(testCase),
      "```"
    ].join("\n"));
    expect(parsed).toEqual(testCase);
    const incomplete = structuredClone(testCase);
    if (incomplete.kind !== "dream") throw new Error("test case must be Dream");
    delete (incomplete.input as Partial<typeof incomplete.input>).userProfiles;
    expect(() => parseUserTestCaseDocument([
      "# Incomplete Dream",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(incomplete),
      "```"
    ].join("\n"))).toThrow("USER_TEST_CASE_FIELD_MISSING");
  });

  it("rebases branch timelines without mutating facts or losing Director wall-clock time", () => {
    const memory = memoryCompressionCase();
    if (memory.kind !== "memory_compression") throw new Error("memory case required");
    memory.input.longTerm = [{
      id: "long-time",
      createdAt: "2026-07-25T06:05:00.000+08:00",
      fact: "The literal date 2026-07-25 remains part of this sentence."
    }];
    const memorySource = structuredClone(memory.input);
    const materializedMemory = materializeMemoryCompressionAtRuntime(
      memory.input,
      new Date("2026-07-27T06:05:00.000+08:00")
    );
    expect(materializedMemory.input.longTerm).toEqual([{
      id: "long-time",
      createdAt: "2026-07-25T22:05:00.000Z",
      fact: "The literal date 2026-07-25 remains part of this sentence."
    }]);
    expect(memory.input).toEqual(memorySource);

    const dream = dreamCase();
    if (dream.kind !== "dream") throw new Error("Dream case required");
    const dreamSource = structuredClone(dream.input);
    const templateTimeline = rebaseDreamTemplateToFixture(
      dream.input,
      "2024-01-02T12:00:00.000+08:00"
    );
    expect(templateTimeline.directorSchedule).toMatchObject({
      date: "2024-01-02",
      items: [
        { startAt: "2024-01-02T08:00:00.000+08:00" },
        { startAt: "2024-01-02T11:00:00.000+08:00" },
        { startAt: "2024-01-02T18:00:00.000+08:00" }
      ]
    });
    expect(templateTimeline.activeTasks[0]?.runAt)
      .toBe("2024-01-03T01:00:00.000Z");
    const materializedDream = materializeDreamAtRuntime(
      {
        ...dream.input,
        now: "2024-01-02T12:00:00.000+08:00",
        activeTasks: templateTimeline.activeTasks,
        directorSchedule: templateTimeline.directorSchedule
      },
      new Date("2026-07-27T12:00:00.000+08:00")
    );
    expect(materializedDream.timeline).toMatchObject({
      dreamScheduleDate: "2026-07-27",
      directorScheduleDate: "2026-07-27"
    });
    expect(materializedDream.input.directorSchedule?.items[1]?.share.at)
      .toBe("2026-07-27T11:00:00.000+08:00");
    expect(dream.input).toEqual(dreamSource);
  });

  it("rejects fixed branch time in a live runtime without an injected clock", () => {
    const dream = dreamCase();
    if (dream.kind !== "dream") throw new Error("Dream case required");
    expect(() => materializeDreamAtRuntime(
      { ...dream.input, timePolicy: "fixed" },
      new Date("2026-07-26T12:00:00.000+08:00")
    )).toThrow("USER_TEST_BRANCH_FIXED_TIME_REQUIRES_CONTROLLED_CLOCK");
  });

  it("samples test-account data read-only and redacts numeric identities and names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-sample-"));
    const source = path.join(root, "source");
    const databasePath = path.join(source, "business/data/sunabot.sqlite");
    const agentRoot = path.join(source, "business/agents/plana");
    const outputPath = path.join(root, "sample.json");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.mkdir(agentRoot, { recursive: true });
    await fs.writeFile(
      path.join(agentRoot, "WORKING_MEMORY.md"),
      `${renderWorkingMemoryMarkdown([{
        id: "working_alice_release",
        content: "Alice discussed account 123456789 with the bot.",
        recordedAt: "2026-07-26T06:00:00.000Z",
        timeZone: "UTC",
        conversationId: "private:123456789",
        conversationScope: "private",
        conversationTitle: "Alice",
        sourceKind: "admin",
        occurredAt: "2026-07-26T06:00:00.000Z",
        userId: "123456789",
        userIds: [""],
        userName: "",
        addressNames: ["", "Alice"],
        batchId: "",
        occurredEndAt: "",
        eventKey: "",
        causalChainKey: "",
        sourceMemoryIds: [""],
        memoryKind: "",
        realityStatus: "",
        factuality: "",
        dreamRunId: "",
        dreamDate: "",
        dreamReviewedAt: ""
      }])}\n`
    );
    await fs.writeFile(
      path.join(agentRoot, "SOUL.md"),
      "Alice protects /Users/alice/private. Trace 1234567890123456789 must not leave the sampler."
    );
    await fs.writeFile(
      path.join(agentRoot, "USER.md"),
      "用户此前显示名为“HiddenAlias”，该别名必须替换。"
    );
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, last_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE memory_records (
        source TEXT NOT NULL,
        position INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
    `);
    database.prepare(
      "INSERT INTO conversations (id, last_at, data_json) VALUES (?, ?, ?)"
    ).run(
      "private:123456789",
      "2026-07-26T07:00:00.000Z",
      JSON.stringify({
        id: "private:123456789",
        scope: "private",
        userId: 123456789,
        title: "Alice",
        messageCount: 5,
        lastAt: "2026-07-26T07:02:00.000Z",
        lastText: "[视频：private-release-video.mp4]",
        messages: [{
          id: "message-private-123456789-1",
          sequence: 1,
          role: "user",
          userId: 123456789,
          senderName: "Alice",
          text: "old-message-outside-limit",
          at: "2026-07-26T06:58:00.000Z"
        }, {
          id: "message-private-123456789-2",
          sequence: 2,
          role: "user",
          userId: 123456789,
          senderName: "Alice",
          text: "[回复消息：private-reply-id] 转发小程序 JSON https://example.test/share/1234567890123456789",
          at: "2026-07-26T06:59:00.000Z"
        }, {
          id: "message-private-123456789-3",
          sequence: 3,
          role: "user",
          userId: 123456789,
          senderName: "Alice",
          text: "北京市朝阳区幸福路12号3栋。",
          at: "2026-07-26T07:00:00.000Z",
          imageUrls: ["https://example.test/private-image"]
        }, {
          id: "message-private-123456789-4",
          sequence: 4,
          role: "assistant",
          userId: 123456789,
          senderName: "Alice",
          text: "internal-orchestrator-result-must-not-enter-sample",
          at: "2026-07-26T07:01:00.000Z",
          visibility: "internal",
          eventKind: "orchestrator_decision"
        }, {
          id: "message-private-123456789-5",
          sequence: 5,
          role: "user",
          userId: 123456789,
          senderName: "Alice",
          text: "[视频：private-release-video.mp4]",
          at: "2026-07-26T07:02:00.000Z"
        }]
      })
    );
    database.prepare(
      "INSERT INTO memory_records (source, position, data_json) VALUES (?, ?, ?)"
    ).run("long_term", 1, JSON.stringify({
      id: 987654321,
      userIds: [22334455],
      groupIds: [99887766],
      fact: "Alice owns account 123456789. @44556677 [回复消息：77889900] 人物-3a01ef2d",
      relatedUsers: "相关用户：QQ 99887766（光、静海教主）；QQ 22334455（光）；QQ 33445566（.）。光（QQ 99887766）负责复核。",
      compressedMessageStart: 20_612,
      compressedMessageEnd: 20_675,
      createdAt: "2026-07-26T06:00:00.000Z 至 2026-07-26T07:00:00.000Z",
      historicalLabel: "2020-01-01T00:00:00.000Z"
    }));
    database.prepare(
      "INSERT INTO memory_records (source, position, data_json) VALUES (?, ?, ?)"
    ).run("user_profile", 1, JSON.stringify({
      userId: "123456789",
      userIds: ["123456789", "22334455"],
      userName: "Alice",
      addressNames: ["Alice"],
      title: "生成",
      preference: "Alice prefers release notes. 图像生成结果保持边界，各自执行，待导入工作区。"
    }));
    database.prepare(
      "INSERT INTO memory_records (source, position, data_json) VALUES (?, ?, ?)"
    ).run("user_profile", 2, JSON.stringify({
      userId: "22334455",
      userIds: ["22334455"],
      userName: "Alice",
      addressNames: ["Alice"],
      preference: "Alice expects a separate scoped pseudonym."
    }));
    database.close();
    try {
      const result = await sampleBranchFixture({
        sourceWorkspace: source,
        agentId: "plana",
        outputPath,
        messageLimit: 4
      });
      const sample = await fs.readFile(result.outputPath, "utf8");
      expect(sample).not.toContain("Alice");
      expect(sample).not.toContain("HiddenAlias");
      expect(sample).not.toContain("光");
      expect(sample).not.toContain("静海教主");
      expect(sample).not.toContain("123456789");
      expect(sample).not.toContain("987654321");
      expect(sample).not.toContain("22334455");
      expect(sample).not.toContain("99887766");
      expect(sample).not.toContain("33445566");
      expect(sample).not.toContain("44556677");
      expect(sample).not.toContain("77889900");
      expect(sample).not.toContain("3a01ef2d");
      expect(sample).not.toContain("2026-07-26");
      expect(sample).not.toContain("/Users/alice");
      expect(sample).not.toContain("1234567890123456789");
      expect(sample).not.toContain("old-message-outside-limit");
      expect(sample).not.toContain("internal-orchestrator-result-must-not-enter-sample");
      expect(sample).not.toContain("private-reply-id");
      expect(sample).not.toContain("private-release-video.mp4");
      expect(sample).toContain("[forwarded-content-redacted]");
      expect(sample).toContain("[sensitive-content-redacted]");
      expect(sample).not.toContain("\"userName\": \"\"");
      expect(sample).not.toContain("\"addressNames\": [\n        \"\"");
      for (const key of [
        "batchId",
        "occurredEndAt",
        "eventKey",
        "causalChainKey",
        "sourceMemoryIds",
        "memoryKind",
        "realityStatus",
        "factuality",
        "dreamRunId",
        "dreamDate",
        "dreamReviewedAt"
      ]) {
        expect(sample).not.toContain(`"${key}"`);
      }
      expect(sample).toContain("name-0001");
      expect(sample).toContain("9000001");
      expect(sample).toContain("图像生成结果保持边界，各自执行，待导入工作区。");
      expect(sample).not.toContain("name-00[time]");
      expect(sample).not.toContain("[number]");
      expect(sample).not.toContain("[name]");
      const parsedSample = JSON.parse(sample);
      expect(parsedSample.fixture).toMatchObject({
        now: "2024-01-01T02:00:00.000Z",
        messageSelection: {
          source: 4,
          productionEligible: 3,
          included: 2,
          mediaSegments: 2,
          quoteSegments: 1,
          excluded: {
            internal: 1,
            failed: 0,
            running: 0,
            other: 0,
            segmentOnly: 1
          }
        },
        longTerm: [{
          compressedMessageStart: 0,
          compressedMessageEnd: 0,
          createdAt: "2024-01-01T00:00:00.000Z"
        }]
      });
      expect(parsedSample.fixture.userProfiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          userId: "9000001",
          userIds: ["9000001", "9000002"],
          addressNames: ["name-0001"]
        }),
        expect.objectContaining({
          userId: "9000002",
          userIds: ["9000002"]
        })
      ]));
      expect(new Set(parsedSample.fixture.userProfiles.map(
        (profile: { userName: string }) => profile.userName
      )).size).toBe(2);
      expect(parsedSample.fixture.conversations[0].messages.map(
        (message: { sequence: number }) => message.sequence
      )).toEqual([1, 2]);
      expect(parsedSample.fixture.conversations[0].messages[1]).toMatchObject({
        imageCount: 1,
        quoteCount: 0
      });
      expect(parsedSample.fixture.conversations[0].messages[0]).toMatchObject({
        imageCount: 0,
        quoteCount: 1
      });
      expect(result.counts).toMatchObject({
        conversations: 1,
        messages: 2,
        longTerm: 1,
        userProfiles: 2
      });
      expect(sample).toContain("\"schemaVersion\": 2");
      expect(sample).toContain("\"irreversible\": true");
      await expect(sampleBranchFixture({
        sourceWorkspace: source,
        agentId: "plana",
        outputPath: path.join(source, "must-not-write.json")
      })).rejects.toThrow("USER_TEST_SAMPLE_OUTPUT_INSIDE_SOURCE");
      const linkedOutputParent = path.join(root, "linked-source");
      await fs.symlink(source, linkedOutputParent, "dir");
      await expect(sampleBranchFixture({
        sourceWorkspace: source,
        agentId: "plana",
        outputPath: path.join(linkedOutputParent, "must-not-write-through-link.json")
      })).rejects.toThrow("USER_TEST_SAMPLE_OUTPUT_PARENT_INVALID");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives deterministic executable branch cases only from a reviewed V2 sample", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-derive-"));
    const samplePath = path.join(root, "sample.json");
    const templatePath = path.join(root, "template.md");
    const firstOutput = "derived-a.md";
    const secondOutput = "derived-b.md";
    const fixture = {
      now: "2024-01-01T02:00:00.000Z",
      workingMemory: [{
        id: "memory-0001",
        content: "Synthetic release evidence remains pending.",
        occurredAt: "2024-01-01T00:00:00.000Z",
        conversationId: "conversation-0001",
        conversationScope: "private" as const,
        conversationTitle: "conversation-0001",
        sourceKind: "admin" as const
      }],
      longTerm: [],
      userProfiles: [],
      persona: {
        name: "fixture-agent",
        soul: "Keep facts grounded.",
        preference: "",
        user: "",
        relation: "",
        air: ""
      },
      conversations: [{
        id: "conversation-0001",
        scope: "private" as const,
        title: "conversation-0001",
        userId: 9_000_001,
        messages: [{
          id: "message-0001",
          sequence: 1,
          role: "user" as const,
          text: "Do not release before the regression result.",
          at: "2024-01-01T01:00:00.000Z",
          userId: 9_000_001,
          senderName: "name-0001"
        }]
      }]
    };
    const sample = {
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
        payloadSha256: cryptoDigest(fixture)
      },
      fixture
    };
    await fs.writeFile(samplePath, JSON.stringify(sample));
    const templateCase = dreamCase();
    if (templateCase.kind !== "dream") throw new Error("test template must be Dream");
    templateCase.input = {
      ...templateCase.input,
      activeTasks: [],
      directorSchedule: null
    };
    await fs.writeFile(templatePath, [
      "# Derived Dream",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(templateCase),
      "```"
    ].join("\n"));
    try {
      await expect(deriveBranchCaseFromSample({
        samplePath,
        templatePath,
        outputRoot: root,
        outputName: "blocked.md",
        confirmReviewedSanitizedSample: false
      })).rejects.toThrow("USER_TEST_SANITIZED_SAMPLE_REVIEW_REQUIRED");
      await deriveBranchCaseFromSample({
        samplePath,
        templatePath,
        outputRoot: root,
        outputName: firstOutput,
        confirmReviewedSanitizedSample: true
      });
      await deriveBranchCaseFromSample({
        samplePath,
        templatePath,
        outputRoot: root,
        outputName: secondOutput,
        confirmReviewedSanitizedSample: true
      });
      const [first, second] = await Promise.all([
        fs.readFile(path.join(root, firstOutput), "utf8"),
        fs.readFile(path.join(root, secondOutput), "utf8")
      ]);
      expect(first).toBe(second);
      expect(parseUserTestCaseDocument(first).input).toMatchObject({
        now: fixture.now,
        workingMemory: fixture.workingMemory,
        conversations: fixture.conversations
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes an older conversation referenced by working memory before recent conversations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-sample-reference-"));
    const source = path.join(root, "source");
    const databasePath = path.join(source, "business/data/sunabot.sqlite");
    const agentRoot = path.join(source, "business/agents/plana");
    const outputPath = path.join(root, "sample.json");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.mkdir(agentRoot, { recursive: true });
    await fs.writeFile(
      path.join(agentRoot, "WORKING_MEMORY.md"),
      `${renderWorkingMemoryMarkdown([{
        id: "working_historical_reference",
        content: "Referenced historical evidence remains available.",
        recordedAt: "2026-07-20T06:00:00.000Z",
        timeZone: "UTC",
        conversationId: "private:historical-reference",
        conversationScope: "private",
        conversationTitle: "Historical reference",
        sourceKind: "admin",
        occurredAt: "2026-07-20T06:00:00.000Z",
        userId: "historical-user",
        userIds: ["historical-user"],
        userName: "Historical user",
        addressNames: ["Historical user"]
      }])}\n`
    );
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, last_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE memory_records (
        source TEXT NOT NULL,
        position INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
    `);
    const insertConversation = database.prepare(
      "INSERT INTO conversations (id, last_at, data_json) VALUES (?, ?, ?)"
    );
    insertConversation.run(
      "private:recent",
      "2026-07-26T07:00:00.000Z",
      JSON.stringify({
        id: "private:recent",
        scope: "private",
        title: "Recent",
        messages: [{
          id: "message-recent",
          sequence: 1,
          role: "user",
          text: "Recent conversation should not displace referenced evidence.",
          at: "2026-07-26T07:00:00.000Z"
        }]
      })
    );
    insertConversation.run(
      "private:historical-reference",
      "2026-07-20T06:00:00.000Z",
      JSON.stringify({
        id: "private:historical-reference",
        scope: "private",
        title: "Historical reference",
        messages: [{
          id: "message-historical",
          sequence: 1,
          role: "user",
          text: "Referenced historical evidence remains available.",
          at: "2026-07-20T06:00:00.000Z"
        }]
      })
    );
    database.close();
    try {
      await sampleBranchFixture({
        sourceWorkspace: source,
        agentId: "plana",
        outputPath,
        conversationLimit: 1,
        includeWorkingMemoryConversations: true
      });
      const sample = JSON.parse(await fs.readFile(outputPath, "utf8"));
      expect(sample.fixture.conversations).toHaveLength(1);
      expect(sample.fixture.conversations[0].messages[0].text)
        .toBe("Referenced historical evidence remains available.");
      expect(sample.fixture.workingMemory[0].conversationId)
        .toBe(sample.fixture.conversations[0].id);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives memory compression from one conversation without unrelated working memory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-memory-derive-"));
    const samplePath = path.join(root, "sample.json");
    const templatePath = path.join(root, "template.md");
    const fixture = {
      now: "2024-01-01T02:00:00.000Z",
      workingMemory: [{
        id: "memory-0001",
        content: "Selected conversation memory.",
        occurredAt: "2024-01-01T00:00:00.000Z",
        conversationId: "conversation-0001",
        conversationScope: "private" as const,
        conversationTitle: "conversation-0001",
        sourceKind: "admin" as const
      }, {
        id: "memory-0002",
        content: "Unrelated conversation memory.",
        occurredAt: "2024-01-01T00:30:00.000Z",
        conversationId: "conversation-0002",
        conversationScope: "private" as const,
        conversationTitle: "conversation-0002",
        sourceKind: "admin" as const
      }],
      longTerm: [],
      userProfiles: [],
      persona: {
        name: "fixture-agent",
        soul: "",
        preference: "",
        user: "",
        relation: "",
        air: ""
      },
      conversations: [{
        id: "conversation-0001",
        scope: "private" as const,
        title: "conversation-0001",
        userId: 9_000_001,
        messages: [{
          id: "message-0001",
          sequence: 1,
          role: "user" as const,
          text: "Keep the selected conversation grounded.",
          at: "2024-01-01T01:00:00.000Z",
          userId: 9_000_001,
          senderName: "name-0001",
          imageCount: 2,
          quoteCount: 1
        }]
      }]
    };
    const sample = {
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
        payloadSha256: cryptoDigest(fixture)
      },
      fixture
    };
    const templateCase = memoryCompressionCase();
    await fs.writeFile(samplePath, JSON.stringify(sample));
    await fs.writeFile(templatePath, [
      "# Derived memory compression",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(templateCase),
      "```"
    ].join("\n"));
    try {
      const result = await deriveBranchCaseFromSample({
        samplePath,
        templatePath,
        outputRoot: root,
        outputName: "derived.md",
        conversationId: "conversation-0001",
        confirmReviewedSanitizedSample: true
      });
      const derived = parseUserTestCaseDocument(await fs.readFile(result.outputPath, "utf8"));
      expect(derived.input).toMatchObject({
        workingMemory: [expect.objectContaining({ id: "memory-0001" })],
        messages: [expect.objectContaining({ imageCount: 2, quoteCount: 1 })]
      });
      expect(JSON.stringify(derived.input)).not.toContain("memory-0002");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepares the isolated Agent parent with private extension-safe permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-prepare-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(path.join(source, "business/config"), { recursive: true });
    await fs.mkdir(path.join(source, "business/agents/plana"), {
      recursive: true,
      mode: 0o700
    });
    await fs.mkdir(path.join(source, "business/agents/koharu"), {
      recursive: true,
      mode: 0o700
    });
    await fs.mkdir(path.join(source, "business/prompts"), { recursive: true });
    await fs.mkdir(path.join(source, "secrets"), { recursive: true });
    await fs.writeFile(
      path.join(source, "business/config/sunabot.json"),
      JSON.stringify({
        server: { host: "127.0.0.1", port: 8787 },
        persona: {
          defaultAgentId: "plana",
          agentWorkspace: "workspace/business/agents/plana",
          systemPromptWorkspace: "workspace/business/prompts"
        },
        providers: {
          defaultProviderId: "fixture",
          items: [{
            id: "fixture",
            kind: "openai-compatible",
            model: "fixture-model",
            apiKeyEnv: "FIXTURE_PROVIDER_KEY",
            envFile: "workspace/secrets/runtime.env"
          }]
        },
        onebot: { accessTokenEnv: "ONEBOT_ACCESS_TOKEN" }
      })
    );
    await fs.writeFile(
      path.join(source, "secrets/runtime.env"),
      "FIXTURE_PROVIDER_KEY=fixture-token\n"
    );
    await fs.writeFile(
      path.join(source, "business/agents/plana/WORKING_MEMORY.md"),
      "private source memory\n"
    );
    await fs.writeFile(
      path.join(source, "business/agents/koharu/SOUL.md"),
      "Koharu fixture persona\n"
    );
    await fs.writeFile(
      path.join(source, "business/agents/koharu/WORKING_MEMORY.md"),
      "private Koharu source memory\n"
    );
    await fs.writeFile(
      path.join(source, "business/agents/plana/LONG_TERM_MEMORY.jsonl"),
      "{\"fact\":\"private legacy memory\"}\n"
    );
    await fs.writeFile(
      path.join(source, "business/agents/koharu/LONG_TERM_MEMORY.jsonl"),
      "{\"fact\":\"private Koharu legacy memory\"}\n"
    );
    await fs.mkdir(path.join(source, "business/agents/plana/data"), { recursive: true });
    await fs.mkdir(path.join(source, "business/agents/koharu/data"), { recursive: true });
    await fs.writeFile(
      path.join(source, "business/agents/plana/data/sunabot.sqlite"),
      "private copied database"
    );
    await fs.writeFile(
      path.join(source, "business/agents/koharu/data/sunabot.sqlite"),
      "private copied Koharu database"
    );
    await fs.writeFile(
      path.join(source, "business/prompts/custom.json"),
      "{\"fixture\":true}\n"
    );
    try {
      await expect(prepareUserTestWorkspace({
        source,
        destination: path.join(root, "missing-agent-destination"),
        confirmCredentialCopy: true,
        agentId: "missing"
      })).rejects.toThrow("源 workspace 不存在 Agent：missing");
      await prepareUserTestWorkspace({
        source,
        destination,
        confirmCredentialCopy: true,
        agentId: "koharu"
      });
      const stat = await fs.stat(path.join(destination, "business/agents"));
      expect(stat.mode & 0o777).toBe(0o700);
      await expect(fs.access(
        path.join(destination, "business/agents/koharu/WORKING_MEMORY.md")
      )).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(
        path.join(destination, "business/agents/koharu/LONG_TERM_MEMORY.jsonl")
      )).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(
        path.join(destination, "business/agents/koharu/data/sunabot.sqlite")
      )).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(
        path.join(destination, "business/agents/koharu/SOUL.md"),
        "utf8"
      )).toBe("Koharu fixture persona\n");
      expect(await fs.readFile(
        path.join(destination, "business/prompts/custom.json"),
        "utf8"
      )).toBe("{\"fixture\":true}\n");
      const preparedConfig = JSON.parse(await fs.readFile(
        path.join(destination, "business/config/sunabot.json"),
        "utf8"
      ));
      expect(preparedConfig.persona.systemPromptWorkspace)
        .toBe("workspace/business/prompts");
      expect(preparedConfig.persona).toMatchObject({
        defaultAgentId: "koharu",
        agentWorkspace: "workspace/business/agents/koharu"
      });
      const isolatedWorkbench = path.join(
        destination,
        "business/agents/koharu/workbench"
      );
      await fs.mkdir(path.join(isolatedWorkbench, "knowledge"), { recursive: true });
      await fs.writeFile(
        path.join(isolatedWorkbench, "knowledge/source-only.md"),
        "copied source knowledge\n"
      );
      await resetUserTestKnowledgeDirectory(destination, isolatedWorkbench);
      await expect(fs.access(
        path.join(isolatedWorkbench, "knowledge/source-only.md")
      )).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(path.join(isolatedWorkbench, "knowledge"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds the run command to its isolated workspace before loading runtime modules", {
    timeout: 30_000
  }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-cli-isolation-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const casePath = path.join(root, "case.md");
    const duplicateEventCasePath = path.join(root, "duplicate-event-case.md");
    const reportPath = path.join(root, "run.json");
    const duplicateReportPath = path.join(root, "duplicate-run.json");
    const duplicateEventReportPath = path.join(root, "duplicate-event-run.json");
    const config = defaultConfig();
    config.bot.adminQq = "10001";
    config.bot.replyDebounceMs = 0;
    config.persona.defaultAgentId = "plana";
    config.persona.agentWorkspace = "workspace/business/agents/plana";
    config.providers = {
      defaultProviderId: "fixture-provider",
      items: [{
        ...config.providers.items[0]!,
        id: "fixture-provider",
        label: "Fixture Provider",
        kind: "codex-responses",
        model: "fixture-model",
        baseUrl: "http://127.0.0.1:1",
        apiKeyEnv: "FIXTURE_PROVIDER_KEY",
        envFile: "workspace/secrets/runtime.env"
      }]
    };
    const testCase = conversationCase("user_private", "private", 20002);
    if (testCase.kind !== "conversation") throw new Error("conversation case required");
    await fs.mkdir(path.join(source, "business/config"), { recursive: true });
    await fs.mkdir(path.join(source, "business/agents/plana"), { recursive: true });
    await fs.mkdir(path.join(source, "secrets"), { recursive: true });
    await fs.writeFile(
      path.join(source, "business/config/sunabot.json"),
      JSON.stringify(config)
    );
    await fs.writeFile(
      path.join(source, "secrets/runtime.env"),
      "FIXTURE_PROVIDER_KEY=fixture-token\n"
    );
    await fs.writeFile(casePath, [
      "# CLI isolation",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(testCase),
      "```"
    ].join("\n"));
    await fs.writeFile(duplicateEventCasePath, [
      "# CLI duplicate event",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify({ ...testCase, id: "actor.user_private.duplicate-event" }),
      "```"
    ].join("\n"));
    try {
      await prepareUserTestWorkspace({
        source,
        destination,
        confirmCredentialCopy: true
      });
      const { VITEST: _vitest, ...childEnvironment } = process.env;
      expect(() => execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("tooling/user-test-harness/cli.ts"),
          "run",
          "--case",
          casePath,
          "--workspace",
          destination,
          "--output",
          reportPath,
          "--execute-provider"
        ],
        {
          cwd: path.resolve("."),
          env: {
            ...childEnvironment,
            SUNABOT_USER_TEST_ALLOW_PROVIDER: "1"
          },
          stdio: "pipe"
        }
      )).toThrow();
      await expect(fs.access(
        path.join(destination, "business/data/sunabot.sqlite")
      )).resolves.toBeUndefined();
      await expect(fs.access(
        path.join(source, "business/data/sunabot.sqlite")
      )).rejects.toMatchObject({ code: "ENOENT" });
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(report.execution.error).not.toBe("USER_TEST_SECONDARY_AGENT_NOT_PREPARED");
      let repeatedCaseError: unknown;
      try {
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            path.resolve("tooling/user-test-harness/cli.ts"),
            "run",
            "--case",
            casePath,
            "--workspace",
            destination,
            "--output",
            duplicateReportPath,
            "--execute-provider"
          ],
          {
            cwd: path.resolve("."),
            env: {
              ...childEnvironment,
              SUNABOT_USER_TEST_ALLOW_PROVIDER: "1"
            },
            stdio: "pipe"
          }
        );
      } catch (error) {
        repeatedCaseError = error;
      }
      expect(String((repeatedCaseError as { stderr?: Buffer })?.stderr))
        .toContain("USER_TEST_WORKSPACE_CASE_ALREADY_RUN");
      await expect(fs.access(duplicateReportPath))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(() => execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("tooling/user-test-harness/cli.ts"),
          "run",
          "--case",
          duplicateEventCasePath,
          "--workspace",
          destination,
          "--output",
          duplicateEventReportPath,
          "--execute-provider"
        ],
        {
          cwd: path.resolve("."),
          env: {
            ...childEnvironment,
            SUNABOT_USER_TEST_ALLOW_PROVIDER: "1"
          },
          stdio: "pipe"
        }
      )).toThrow();
      const duplicateEvent = JSON.parse(await fs.readFile(duplicateEventReportPath, "utf8"));
      expect(duplicateEvent.execution).toMatchObject({
        status: "failed",
        error: "USER_TEST_ONEBOT_EVENT_ALREADY_USED"
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drives a raw OneBot message through Runtime, a successful Provider response, and outbox", {
    timeout: 30_000
  }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-runtime-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const previousWorkspace = process.env.SUNABOT_WORKSPACE;
    const previousTimeout = process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
    const config = defaultConfig();
    config.bot.adminQq = "10001";
    config.bot.replyDebounceMs = 0;
    config.bot.orchestrator.enabled = true;
    config.persona.defaultAgentId = "koharu";
    config.persona.agentWorkspace = "workspace/business/agents/koharu";
    config.providers = {
      defaultProviderId: "fixture-provider",
      items: [{
        ...config.providers.items[0]!,
        id: "fixture-provider",
        label: "Fixture Provider",
        kind: "codex-responses",
        model: "fixture-model",
        baseUrl: "https://provider.fixture.invalid",
        apiKeyEnv: "FIXTURE_PROVIDER_KEY",
        envFile: "workspace/secrets/runtime.env"
      }]
    };
    await fs.mkdir(path.join(source, "business/config"), { recursive: true });
    await fs.mkdir(path.join(source, "business/agents/koharu"), {
      recursive: true,
      mode: 0o700
    });
    await fs.mkdir(path.join(source, "business/agents/koharu/workbench/knowledge"), {
      recursive: true,
      mode: 0o700
    });
    await fs.mkdir(path.join(source, "secrets"), { recursive: true });
    await fs.writeFile(
      path.join(source, "business/config/sunabot.json"),
      JSON.stringify(config)
    );
    await fs.writeFile(
      path.join(source, "secrets/runtime.env"),
      "FIXTURE_PROVIDER_KEY=fixture-token\n"
    );
    await fs.writeFile(
      path.join(source, "business/agents/koharu/workbench/knowledge/source-only.md"),
      "source knowledge must not survive fixture reset\n"
    );
    const providerOutputs = [
      {
        text: JSON.stringify({
          should_reply: true,
          reason: "The fixture user explicitly requested a result.",
          reply_to_message_id: "99"
        })
      },
      {
        text: "夹具主对话已收到。",
        calls: [{
          name: "add_workmemory",
          args: { action: "skip", content: null }
        }]
      }
    ];
    const fetchMock = vi.fn(async () => {
      const output = providerOutputs.shift();
      if (!output) throw new Error("unexpected fixture Provider request");
      return codexSseResponse(output.text, output.calls);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await prepareUserTestWorkspace({
        source,
        destination,
        confirmCredentialCopy: true
      });
      process.env.SUNABOT_WORKSPACE = destination;
      process.env.SUNABOT_USER_TEST_TIMEOUT_MS = "5000";
      vi.resetModules();
      const { runRuntimeUserTest } = await import(
        "../../tooling/user-test-harness/runtimeDriver.js"
      );
      const runtimeCase = conversationCase("admin_group", "group", 20002, 30003);
      if (runtimeCase.kind !== "conversation") throw new Error("conversation case required");
      runtimeCase.input.fixture = {
        resetKnowledge: ["native"],
        workbenchFiles: [{
          backend: "native",
          path: "knowledge/fixture-only.md",
          content: "fixture input\n"
        }]
      };
      const report = await runRuntimeUserTest(runtimeCase, "b".repeat(64));
      expect(
        report.execution.status,
        JSON.stringify({
          execution: report.execution,
          branch: report.observation.branch,
          requestLogs: report.observation.requestLogs
        }, null, 2)
      ).toBe("passed");
      expect(report.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(report.observation.tools).toEqual(["add_workmemory"]);
      expect(await fs.readFile(
        path.join(
          destination,
          "business/agents/koharu/workbench/knowledge/fixture-only.md"
        ),
        "utf8"
      )).toBe("fixture input\n");
      await expect(fs.access(path.join(
        destination,
        "business/agents/koharu/workbench/knowledge/source-only.md"
      ))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(report.observation.outbound)).toContain("夹具主对话已收到");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
      else process.env.SUNABOT_WORKSPACE = previousWorkspace;
      if (previousTimeout == null) delete process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
      else process.env.SUNABOT_USER_TEST_TIMEOUT_MS = previousTimeout;
      vi.resetModules();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50
      });
    }
  });

  it("drives memory compression and Dream through their production branches", {
    timeout: 30_000
  }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-branches-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const previousWorkspace = process.env.SUNABOT_WORKSPACE;
    const previousTimeout = process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
    const config = defaultConfig();
    config.bot.adminQq = "10001";
    config.persona.defaultAgentId = "koharu";
    config.persona.agentWorkspace = "workspace/business/agents/koharu";
    config.providers = {
      defaultProviderId: "fixture-provider",
      items: [{
        ...config.providers.items[0]!,
        id: "fixture-provider",
        label: "Fixture Provider",
        kind: "codex-responses",
        model: "fixture-model",
        baseUrl: "https://provider.fixture.invalid",
        apiKeyEnv: "FIXTURE_PROVIDER_KEY",
        envFile: "workspace/secrets/runtime.env"
      }]
    };
    await fs.mkdir(path.join(source, "business/config"), { recursive: true });
    await fs.mkdir(path.join(source, "business/agents/koharu"), {
      recursive: true,
      mode: 0o700
    });
    await fs.mkdir(path.join(source, "secrets"), { recursive: true });
    await fs.writeFile(
      path.join(source, "business/config/sunabot.json"),
      JSON.stringify(config)
    );
    await fs.writeFile(
      path.join(source, "secrets/runtime.env"),
      "FIXTURE_PROVIDER_KEY=fixture-token\n"
    );
    const providerOutputs = [
      JSON.stringify({ profiles: [] }),
      JSON.stringify({
        facts: [{
          id: null,
          fact: "0.1.4 必须在回归测试全部通过后发布。"
        }],
        allPreviousMemoriesInvalidated: true
      }),
      JSON.stringify({
        schemaVersion: 1,
        dream: {
          text: "我梦见测试清单变成一条发光的路，只有回归测试全部通过，0.1.4 才走向发布终点。",
          factuality: "imagined"
        },
        longTermReviews: [{
          sourceIds: ["long_fixture_release"],
          action: "retain",
          canonical: null,
          importance: 0.9,
          futureRelevance: 0.9,
          emotionalSalience: 0.4,
          confidence: 1,
          reason: "发布门禁仍然有效。"
        }],
        workingReviews: [{
          sourceIds: ["working_fixture_release"],
          action: "retain",
          canonical: null,
          confidence: 1,
          reason: "近期发布约束保持不变。"
        }],
        personaAdjustment: null,
        fieldKnowledge: null
      })
    ];
    const fetchMock = vi.fn(async () => {
      const output = providerOutputs.shift();
      if (!output) throw new Error("unexpected fixture Provider request");
      return codexSseResponse(output);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await prepareUserTestWorkspace({
        source,
        destination,
        confirmCredentialCopy: true
      });
      process.env.SUNABOT_WORKSPACE = destination;
      process.env.SUNABOT_USER_TEST_TIMEOUT_MS = "30000";
      vi.resetModules();
      const { runRuntimeUserTest } = await import(
        "../../tooling/user-test-harness/runtimeDriver.js"
      );
      const memoryReport = await runRuntimeUserTest(
        memoryCompressionCase(),
        "c".repeat(64)
      );
      expect(memoryReport.execution.status).toBe("passed");
      expect(memoryReport.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(JSON.stringify(memoryReport.observation.branch)).toContain("0.1.4");

      const dreamReport = await runRuntimeUserTest(
        dreamCase(),
        "d".repeat(64)
      );
      expect(
        dreamReport.execution.status,
        JSON.stringify({
          execution: dreamReport.execution,
          branch: dreamReport.observation.branch,
          requestLogs: dreamReport.observation.requestLogs
        }, null, 2)
      ).toBe("passed");
      expect(dreamReport.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(JSON.stringify(dreamReport.observation.branch)).toContain("0.1.4");
      expect(dreamReport.observation.branch).toMatchObject({
        seeded: {
          longTermCount: 1,
          userProfileCount: 1,
          activeTaskCount: 1,
          directorSchedule: {
            status: "committed",
            date: dreamReport.observation.branch.seeded.timeline.directorScheduleDate
          }
        }
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
      else process.env.SUNABOT_WORKSPACE = previousWorkspace;
      if (previousTimeout == null) delete process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
      else process.env.SUNABOT_USER_TEST_TIMEOUT_MS = previousTimeout;
      vi.resetModules();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat the Provider tool catalog as invoked tools", () => {
    const logs = [{
      category: "model.request",
      action: "codex.complete",
      metadata: { toolNames: ["websearch", "send_file"] }
    }, {
      category: "tool.call",
      action: "websearch",
      request: { arguments: { query: "fixture" } },
      response: { ok: true }
    }];
    expect(extractCalledToolNames(logs)).toEqual(["websearch"]);
    expect(extractProviderToolCatalog([{
      category: "model.request",
      request: {
        tools: [
          { name: "websearch" },
          { function: { name: "send_file" } }
        ]
      }
    }])).toEqual(["send_file", "websearch"]);
    const availability = evaluateHarnessAssertions({
      expected: {
        requiredAvailableTools: ["websearch"],
        forbiddenAvailableTools: ["codex"]
      },
      toolCalls: [],
      outbound: [],
      requestLogs: [{
        category: "model.request",
        request: { tools: [{ name: "websearch" }] }
      }]
    });
    expect(availability.every((assertion) => assertion.passed)).toBe(true);
  });

  it("records dynamic MCP tools and requires a successful tool result", () => {
    const calls = extractToolCallObservations([{
      category: "tool.call",
      action: "mcp__calendar__list_events",
      request: { callId: "call-1", argumentKeys: ["date"] },
      response: { ok: false, error: "calendar unavailable" },
      metadata: { stage: "reply" }
    }, {
      category: "tool.call",
      action: "mcp__calendar__list_events",
      request: { callId: "call-2", argumentKeys: ["date"] },
      response: { content: [{ type: "text", text: "no events" }] },
      metadata: { stage: "reply" }
    }]);
    expect(calls).toEqual([
      expect.objectContaining({
        name: "mcp__calendar__list_events",
        callId: "call-1",
        status: "failed"
      }),
      expect.objectContaining({
        name: "mcp__calendar__list_events",
        callId: "call-2",
        status: "succeeded"
      })
    ]);
    expect(extractCalledToolNames([{
      category: "tool.call",
      action: "mcp__calendar__list_events",
      response: { ok: true }
    }])).toEqual(["mcp__calendar__list_events"]);
    expect(evaluateHarnessAssertions({
      expected: { requiredTools: ["mcp__calendar__list_events"] },
      toolCalls: calls.slice(0, 1),
      outbound: []
    })[0]?.passed).toBe(false);
    expect(evaluateHarnessAssertions({
      expected: { requiredTools: ["mcp__calendar__list_events"] },
      toolCalls: calls,
      outbound: []
    })[0]?.passed).toBe(true);
    expect(evaluateHarnessAssertions({
      expected: { forbiddenSuccessfulTools: ["mcp__calendar__list_events"] },
      toolCalls: calls.slice(0, 1),
      outbound: []
    })[0]?.passed).toBe(true);
    expect(evaluateHarnessAssertions({
      expected: { forbiddenSuccessfulTools: ["mcp__calendar__list_events"] },
      toolCalls: calls,
      outbound: []
    })[0]?.passed).toBe(false);
  });

  it("distinguishes message, asset, and poke outbound evidence", () => {
    const assertions = evaluateHarnessAssertions({
      expected: {
        requiredOutboundKinds: ["poke"],
        forbiddenOutboundKinds: ["message", "asset"],
        minimumOutboundCount: 1,
        maximumOutboundCount: 1
      },
      toolCalls: [],
      outbound: [{ kind: "poke", value: { userId: 10001 } }]
    });
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("limits conversation text assertions to user-facing text and asset names", () => {
    const values = extractConversationUserFacingTextValues([{
      kind: "message",
      value: {
        text: "语音功能未启用",
        media: [{
          filePath: "/Users/test/internal.png",
          url: "/generated-images/internal.png"
        }],
        contentSegments: [
          { type: "text", text: "图片已发送" },
          { type: "image", imageIndex: 0 }
        ]
      }
    }, {
      kind: "asset",
      value: {
        asset: {
          name: "测试结果.txt",
          source: "/Users/test/internal.txt"
        }
      }
    }, {
      kind: "poke",
      value: { userId: 10001 }
    }]);

    expect(values).toEqual(["语音功能未启用", "图片已发送", "测试结果.txt"]);
    const assertions = evaluateHarnessAssertions({
      expected: {
        requiredText: ["语音功能未启用", "测试结果.txt"],
        forbiddenText: ["/Users/", "internal.png"]
      },
      toolCalls: [],
      outbound: [],
      textValues: values
    });
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("fails Provider evidence when retries end in a terminal failure", () => {
    const assertions = evaluateProviderEvidence([{
      category: "model.response",
      action: "codex.complete",
      response: { ok: false, error: "fetch failed", willRetry: false }
    }, {
      category: "runtime.action",
      action: "reply.failed",
      response: { ok: false }
    }]);
    expect(assertions).toEqual([
      expect.objectContaining({ id: "provider.successful_response", passed: false }),
      expect.objectContaining({ id: "provider.terminal_failures", passed: false })
    ]);
  });

  it("serializes parallel appends to one Markdown report and releases its directory lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-report-"));
    const reportPath = path.join(root, "run.json");
    const targetPath = path.join(root, "shared.md");
    const run = {
      schemaVersion: 1 as const,
      runId: "parallel-run",
      caseId: "parallel-case",
      caseDigest: "a".repeat(64),
      sourceRevision: "b".repeat(40),
      kind: "conversation" as const,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      workspaceMode: "isolated" as const,
      execution: { status: "passed" as const, assertions: [] },
      observation: { outbound: [], tools: [], toolCalls: [], requestLogs: [] },
      quality: { status: "pending_review" as const, criteria: [] },
      verdict: "inconclusive" as const
    };
    await fs.writeFile(reportPath, JSON.stringify(run));
    try {
      await Promise.all(Array.from({ length: 8 }, (_, index) => appendMarkdownReport({
        reportPath,
        targetPath,
        suite: `Parallel ${index}`
      })));
      const markdown = await fs.readFile(targetPath, "utf8");
      expect(markdown.match(/^## Parallel /gmu)).toHaveLength(8);
      await appendMarkdownReport({
        reportPath,
        targetPath,
        suite: "Parallel 0"
      });
      expect(
        (await fs.readFile(targetPath, "utf8")).match(/^## Parallel /gmu)
      ).toHaveLength(8);
      await expect(fs.stat(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a passing review when a quality score is below the case threshold", () => {
    const run = {
      schemaVersion: 1 as const,
      runId: "run-1",
      caseId: "case-1",
      caseDigest: "a".repeat(64),
      sourceRevision: "b".repeat(40),
      kind: "conversation" as const,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      workspaceMode: "isolated" as const,
      execution: { status: "passed" as const, assertions: [] },
      observation: { outbound: [], tools: [], toolCalls: [], requestLogs: [] },
      quality: {
        status: "pending_review" as const,
        criteria: [{ id: "accuracy", description: "Facts are accurate.", minimumScore: 4 }]
      },
      verdict: "inconclusive" as const
    };

    expect(() => validateAndSealUserTestReport(run, {
      schemaVersion: 1,
      runId: "run-1",
      caseId: "case-1",
      reviewer: "fixture-agent",
      reviewedAt: new Date(2).toISOString(),
      criteria: [{ id: "accuracy", score: 3, evidence: "One required fact was absent." }],
      verdict: "pass",
      summary: "Incomplete answer."
    })).toThrow("USER_TEST_REVIEW_VERDICT_INVALID");
  });

  it.each([
    ["blank reviewer", { reviewer: " " }],
    ["invalid review time", { reviewedAt: "not-a-time" }],
    ["blank summary", { summary: " " }]
  ])("rejects quality review metadata with %s", (_label, override) => {
    const run = {
      schemaVersion: 1 as const,
      runId: "review-metadata-run",
      caseId: "review-metadata-case",
      caseDigest: "a".repeat(64),
      sourceRevision: "b".repeat(40),
      kind: "conversation" as const,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      workspaceMode: "isolated" as const,
      execution: { status: "passed" as const, assertions: [] },
      observation: { outbound: [], tools: [], toolCalls: [], requestLogs: [] },
      quality: {
        status: "pending_review" as const,
        criteria: [{ id: "accuracy", description: "Facts are accurate.", minimumScore: 4 }]
      },
      verdict: "inconclusive" as const
    };
    expect(() => validateAndSealUserTestReport(run, {
      schemaVersion: 1,
      runId: run.runId,
      caseId: run.caseId,
      reviewer: "fixture-agent",
      reviewedAt: new Date(2).toISOString(),
      criteria: [{
        id: "accuracy",
        score: 5,
        evidence: "The output is grounded in the captured evidence."
      }],
      verdict: "pass",
      summary: "Pass.",
      ...override
    })).toThrow("USER_TEST_REVIEW_METADATA_INVALID");
  });

  it("preserves a blocked execution verdict while keeping it outside the release gate", () => {
    const run = {
      schemaVersion: 1 as const,
      runId: "blocked-run",
      caseId: "blocked-case",
      caseDigest: "c".repeat(64),
      sourceRevision: "b".repeat(40),
      kind: "dream" as const,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      workspaceMode: "isolated" as const,
      execution: {
        status: "blocked" as const,
        assertions: [],
        error: "Provider unavailable"
      },
      observation: { outbound: [], tools: [], toolCalls: [], requestLogs: [] },
      quality: {
        status: "pending_review" as const,
        criteria: [{
          id: "availability",
          description: "The dependency is available.",
          minimumScore: 4
        }]
      },
      verdict: "blocked" as const
    };
    expect(validateAndSealUserTestReport(run, {
      schemaVersion: 1,
      runId: "blocked-run",
      caseId: "blocked-case",
      reviewer: "fixture-agent",
      reviewedAt: new Date(2).toISOString(),
      criteria: [{
        id: "availability",
        score: 1,
        evidence: "The required Provider was unavailable."
      }],
      verdict: "blocked",
      summary: "Execution could not start."
    }).verdict).toBe("blocked");
  });

  it("binds the release gate to the current revision, case digest, run, and reviewer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-release-"));
    const casePath = path.join(root, "case.md");
    const reportPath = path.join(root, "report.json");
    const manifestPath = path.join(root, "manifest.json");
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
    const testCase = conversationCase("user_private", "private", 20002);
    await fs.writeFile(casePath, [
      "# Release case",
      USER_TEST_CASE_MARKER,
      "```json",
      JSON.stringify(testCase),
      "```"
    ].join("\n"));
    const document = await readUserTestCaseDocument(casePath);
    const run = {
      schemaVersion: 1 as const,
      runId: "release-run-1",
      caseId: testCase.id,
      caseDigest: document.digest,
      sourceRevision,
      kind: "conversation" as const,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      workspaceMode: "isolated" as const,
      execution: { status: "passed" as const, assertions: [] },
      observation: { outbound: [], tools: [], toolCalls: [], requestLogs: [] },
      quality: {
        status: "pending_review" as const,
        criteria: testCase.quality.criteria
      },
      verdict: "inconclusive" as const
    };
    const sealed = validateAndSealUserTestReport(run, {
      schemaVersion: 1,
      runId: run.runId,
      caseId: run.caseId,
      reviewer: "fixture-agent-1",
      reviewedAt: new Date(2).toISOString(),
      criteria: [{
        id: "accuracy",
        score: 5,
        evidence: "The captured result satisfies the case."
      }],
      verdict: "pass",
      summary: "Pass."
    });
    await fs.writeFile(reportPath, JSON.stringify(sealed));
    const manifest = {
      schemaVersion: 1,
      suiteId: "release-suite",
      sourceRevision,
      cases: [{
        caseDocument: "case.md",
        reports: ["report.json"],
        minimumIndependentRuns: 1
      }]
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    try {
      await expect(gateUserTestReleaseManifest(manifestPath)).resolves.toMatchObject({
        suiteId: "release-suite",
        sourceRevision,
        cases: [{ caseId: testCase.id, runs: 1, reviewers: 1 }]
      });
      await fs.writeFile(manifestPath, JSON.stringify({
        ...manifest,
        sourceRevision: "0".repeat(40)
      }));
      await expect(gateUserTestReleaseManifest(manifestPath))
        .rejects.toThrow("USER_TEST_RELEASE_REVISION_MISMATCH");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function conversationCase(
  actor: "admin_private" | "user_private" | "admin_group" | "user_group",
  messageType: "private" | "group",
  userId: number,
  groupId?: number
): UserTestCase {
  return {
    schemaVersion: 1,
    id: `actor.${actor}`,
    title: actor,
    kind: "conversation",
    goal: "The requested tool is used and the result is returned.",
    input: {
      actor,
      accountId: "primary",
      selfId: "40004",
      event: {
        post_type: "message",
        message_type: messageType,
        message_id: 99,
        self_id: 40004,
        user_id: userId,
        ...(groupId ? { group_id: groupId } : {}),
        time: 1_788_000_000,
        sender: { nickname: "fixture-user" },
        message: "hello",
        raw_message: "hello"
      }
    },
    expected: { minimumOutboundCount: 1 },
    quality: {
      criteria: [{
        id: "accuracy",
        description: "The answer is accurate and grounded in tool output.",
        minimumScore: 4
      }]
    }
  };
}

function memoryCompressionCase(): UserTestCase {
  return {
    schemaVersion: 1,
    id: "branch.memory-compression",
    title: "Memory compression",
    kind: "memory_compression",
    goal: "The release gate is retained in working memory.",
    input: {
      timePolicy: "rebase_to_runtime",
      now: "2026-07-26T06:05:00.000+08:00",
      workingMemory: [],
      longTerm: [],
      userProfiles: [],
      conversation: {
        id: "private:20002",
        scope: "private",
        title: "Fixture user",
        userId: 20002
      },
      messages: [{
        id: "memory-message-1",
        sequence: 1,
        role: "user",
        text: "0.1.4 必须在回归测试全部通过后发布。",
        at: "2026-07-26T06:00:00.000+08:00",
        userId: 20002,
        senderName: "Fixture user"
      }]
    },
    expected: {
      requiredText: ["0.1.4", "回归测试"],
      minimumOutboundCount: 0,
      maximumOutboundCount: 0
    },
    quality: {
      criteria: [{
        id: "grounding",
        description: "The memory remains grounded in the fixture.",
        minimumScore: 4
      }]
    }
  };
}

function dreamCase(): UserTestCase {
  return {
    schemaVersion: 1,
    id: "branch.dream",
    title: "Dream",
    kind: "dream",
    goal: "Dream is grounded in explicit working memory and conversation input.",
    input: {
      timePolicy: "rebase_to_runtime",
      now: "2026-07-26T12:00:00.000+08:00",
      workingMemory: [{
        id: "working_fixture_release",
        content: "0.1.4 必须在回归测试全部通过后发布。",
        occurredAt: "2026-07-26T06:00:00.000+08:00",
        conversationId: "private:20002",
        conversationScope: "private",
        conversationTitle: "Fixture user",
        sourceKind: "admin"
      }],
      longTerm: [{
        id: "long_fixture_release",
        fact: "0.1.4 remains gated by regression evidence.",
        occurredAt: "2026-07-25T06:00:00.000+08:00",
        factuality: "fact"
      }],
      userProfiles: [{
        id: "profile_fixture_user",
        userId: "20002",
        userName: "Fixture user",
        fact: "Fixture user asks for regression evidence before release."
      }],
      persona: {
        name: "Fixture Agent",
        soul: "Keep release statements grounded in test evidence.",
        preference: "",
        user: "",
        relation: "",
        air: ""
      },
      conversations: [{
        id: "private:20002",
        scope: "private",
        title: "Fixture user",
        userId: 20002,
        messages: [{
          id: "dream-message-1",
          sequence: 1,
          role: "user",
          text: "回归测试通过后再发布 0.1.4。",
          at: "2026-07-26T07:00:00.000+08:00",
          userId: 20002,
          senderName: "Fixture user"
        }]
      }],
      activeTasks: [{
        id: "fixture_release_review",
        name: "Review release evidence",
        runAt: "2026-07-27T09:00:00.000+08:00",
        context: "Review the regression evidence before release.",
        targetConversationId: "private:20002",
        mentionUserIds: []
      }],
      directorSchedule: directorScheduleFixture()
    },
    expected: {
      requiredText: ["0.1.4", "回归测试"],
      minimumOutboundCount: 0,
      maximumOutboundCount: 0
    },
    quality: {
      criteria: [{
        id: "grounding",
        description: "The Dream remains grounded in supplied evidence.",
        minimumScore: 4
      }]
    }
  };
}

function directorScheduleFixture() {
  const item = (
    id: string,
    startAt: string,
    endAt: string,
    share: boolean
  ) => ({
    id,
    startAt,
    endAt,
    activity: `Fixture activity ${id}`,
    location: "Fixture workspace",
    participants: ["Fixture Agent"],
    intent: "Keep release evidence grounded.",
    variant: "fixture",
    share: share
      ? {
          enabled: true,
          at: startAt,
          textIntent: "Share verified progress only.",
          selfiePrompt: "Reviewing a test checklist."
        }
      : {
          enabled: false,
          at: null,
          textIntent: null,
          selfiePrompt: null
        }
  });
  return {
    schemaVersion: 1 as const,
    date: "2026-07-26",
    timeZone: "Asia/Shanghai",
    theme: "Fixture validation",
    summary: "Review evidence without claiming an unverified release.",
    items: [
      item(
        "morning",
        "2026-07-26T08:00:00.000+08:00",
        "2026-07-26T09:00:00.000+08:00",
        false
      ),
      item(
        "noon",
        "2026-07-26T11:00:00.000+08:00",
        "2026-07-26T12:00:00.000+08:00",
        true
      ),
      item(
        "evening",
        "2026-07-26T18:00:00.000+08:00",
        "2026-07-26T19:00:00.000+08:00",
        false
      )
    ]
  };
}

function codexSseResponse(
  text: string,
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
) {
  const output = [{
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }]
  }, ...calls.map((call, index) => ({
    type: "function_call",
    name: call.name,
    call_id: `fixture-call-${index}-${call.name}`,
    arguments: JSON.stringify(call.args),
    status: "completed"
  }))];
  const events = output.map((item, outputIndex) => ({
    type: "response.output_item.done",
    output_index: outputIndex,
    item
  }));
  events.push({
    type: "response.completed",
    response: { status: "completed", output }
  } as never);
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }
  );
}

function cryptoDigest(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
