import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import { readRequestLogs } from "../../adapters/observability/requestLog.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { resolveProjectPath } from "../../packages/platform/projectPaths.js";
import { systemModelTimeZone } from "../../packages/platform/systemTime.js";
import { readAirKnowledge, replaceAirKnowledge } from "../../services/air/public.js";
import { resolveAgentWorkbench } from "../../services/agents/public.js";
import {
  ensureWorkingMemoryDocument,
  readWorkingMemoryDocument,
  replaceWorkingMemoryDocument,
  type WorkingMemoryDocumentItem
} from "../../services/memory/workingMemoryDocument.js";
import { loadPersona } from "../../services/agent/persona.js";
import {
  conversationRecordId,
  persistentIncomingKey
} from "../../src/runtime/messagingAttachmentHelpers.js";
import type { ConversationRecord } from "../../src/types.js";
import type { MemoryClaim } from "../../services/memory/memoryScheduler.js";
import { AgentRuntimeManager } from "../../services/agents/agentRuntimeManager.js";
import { BroadcastStormDetector } from "../../services/orchestration/broadcastStormDetector.js";
import type {
  ConversationUserTestInput,
  DreamUserTestInput,
  HarnessAssertion,
  MemoryCompressionUserTestInput,
  UserTestCase,
  UserTestRunReport,
  WorkingMemoryFixtureItem
} from "./contracts.js";
import { RecordingMessagingPort } from "./recordingMessagingPort.js";
import {
  materializeDreamAtRuntime,
  materializeMemoryCompressionAtRuntime
} from "./timeline.js";
import {
  evaluateHarnessAssertions,
  evaluateProviderEvidence,
  extractCalledToolNames,
  extractConversationUserFacingTextValues,
  extractToolCallObservations,
  validateConversationActor
} from "./assertions.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function runRuntimeUserTest(
  testCase: UserTestCase,
  caseDigest: string
): Promise<UserTestRunReport> {
  const startedAt = new Date().toISOString();
  const runId = `${testCase.id}-${nanoid(10)}`;
  const sourceRevision = await currentSourceRevision();
  let built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>> | undefined;
  const assertions: HarnessAssertion[] = [];
  const observation: UserTestRunReport["observation"] = {
    outbound: [],
    tools: [],
    toolCalls: [],
    requestLogs: []
  };
  let executionStatus: UserTestRunReport["execution"]["status"] = "passed";
  let executionError: string | undefined;
  try {
    const [{ loadConfig }, { buildApp }] = await Promise.all([
      import("../../src/config.js"),
      import("../../apps/api/server.js")
    ]);
    const config = await loadConfig();
    projectConversationActor(config, testCase);
    built = await buildApp({
      config,
      initializeRuntime: false,
      onebotListener: false,
      accountRuntimeReconciler: false,
      runtimeProbeClient: false,
      agentRegistry: { allowUnmarkedMigration: true },
      logger: false
    });
    projectConversationActor(built.runtime.config, testCase);
    await prepareRuntime(built.runtime, config);
    const requestLogStart = Date.now();
    if (testCase.kind === "conversation") {
      const result = await runConversationCase(
        built,
        testCase,
        testCase.input as ConversationUserTestInput
      );
      observation.inbound = result.inbound;
      observation.outbound = result.transport.observations();
      observation.branch = result.session;
      assertions.push(...result.assertions);
    } else if (testCase.kind === "memory_compression") {
      const result = await runMemoryCompressionCase(
        built,
        testCase.input as MemoryCompressionUserTestInput
      );
      observation.branch = result;
      assertions.push({
        id: "memory_compression.completed",
        passed: result.ok,
        expected: true,
        actual: result.ok
      });
    } else {
      const result = await runDreamCase(
        built,
        testCase.input as DreamUserTestInput
      );
      observation.branch = result;
      assertions.push({
        id: "dream.completed",
        passed: result.run?.status === "completed",
        expected: "completed",
        actual: result.run?.status ?? "no_run"
      });
    }
    observation.requestLogs = (await readRequestLogs({ config, limit: 500 }))
      .filter((entry) => Date.parse(String((entry as Record<string, unknown>).at ?? "")) >= requestLogStart);
    observation.toolCalls = extractToolCallObservations(observation.requestLogs);
    observation.tools = extractCalledToolNames(observation.requestLogs);
    assertions.push(...evaluateProviderEvidence(observation.requestLogs));
    assertions.push(...evaluateHarnessAssertions({
      expected: testCase.expected,
      toolCalls: observation.toolCalls,
      outbound: observation.outbound,
      requestLogs: observation.requestLogs,
      textValues: assertionTextValues(testCase.kind, observation)
    }));
    if (assertions.some((assertion) => !assertion.passed)) executionStatus = "failed";
  } catch (error) {
    executionStatus = blockedError(error) ? "blocked" : "failed";
    executionError = stableError(error);
  } finally {
    await built?.app.close().catch(() => undefined);
  }
  return {
    schemaVersion: 1,
    runId,
    caseId: testCase.id,
    caseDigest,
    sourceRevision,
    kind: testCase.kind,
    startedAt,
    finishedAt: new Date().toISOString(),
    workspaceMode: "isolated",
    execution: {
      status: executionStatus,
      assertions,
      ...(executionError ? { error: executionError } : {})
    },
    observation,
    quality: {
      status: "pending_review",
      criteria: testCase.quality.criteria
    },
    verdict: executionStatus === "blocked"
      ? "blocked"
      : executionStatus === "failed"
        ? "fail"
        : "inconclusive"
  };
}

function projectConversationActor(config: AppConfig, testCase: UserTestCase) {
  if (testCase.kind !== "conversation") return;
  const input = testCase.input as ConversationUserTestInput;
  const userId = String(input.event.user_id ?? "").trim();
  if (!/^\d{1,32}$/u.test(userId)) throw new Error("USER_TEST_ACTOR_USER_ID_INVALID");
  config.bot.adminQq = input.actor.startsWith("admin_")
    ? userId
    : fixtureAdministratorQq(userId);
}

function fixtureAdministratorQq(userId: string) {
  return userId === "9000000001" ? "9000000002" : "9000000001";
}

async function prepareRuntime(
  runtime: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>["runtime"],
  config: AppConfig
) {
  await runtime.ensureAgentPromptFiles(config);
  await ensureWorkingMemoryDocument(config);
  await runtime.memoryScheduler.initialize();
  runtime.persona = await loadPersona(config);
}

async function runConversationCase(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  testCase: UserTestCase,
  input: ConversationUserTestInput
) {
  const event = structuredClone(input.event) as OneBotEvent;
  const parsed = parseOneBotInboundMessage(event);
  if (!parsed) throw new Error("USER_TEST_ONEBOT_EVENT_NOT_MESSAGE");
  parsed.accountId = input.accountId;
  parsed.agentId = built.runtime.config.persona.defaultAgentId;
  const assertions = validateConversationActor(testCase, built.runtime.config.bot.adminQq);
  if (assertions.some((assertion) => !assertion.passed)) {
    return {
      inbound: parsed,
      assertions,
      transport: new RecordingMessagingPort({
        selfId: input.selfId,
        accountId: input.accountId
      }),
      session: { skipped: "actor_contract_failed" }
    };
  }
  const conversationId = conversationRecordId(parsed);
  assertFreshConversationEvent(built.runtime, conversationId, parsed);
  if (input.replyEnabled !== false) {
    const record = built.runtime.ensureConversationRecord(parsed, parsed.time);
    record.replyEnabled = true;
    if (record.scope === "user_group") {
      record.orchestratorEnabled = true;
      record.orchestratorResponseTimeOverrideEnabled = true;
      record.orchestratorResponseTimeMs = 1_000;
    }
    built.runtime.persistConversationRecords();
  }
  const transport = new RecordingMessagingPort({
    selfId: input.selfId,
    accountId: input.accountId
  });
  const manager = new AgentRuntimeManager(built.agentRegistry, {
    defaultRuntime: built.runtime,
    createRuntime: () => {
      throw new Error("USER_TEST_SECONDARY_AGENT_NOT_PREPARED");
    },
    initializeRuntime: false,
    broadcastStormDetector: new BroadcastStormDetector(built.getConfig().broadcastStorm)
  });
  const gateway = new OneBotGateway(
    http.createServer(),
    built.getConfig(),
    manager,
    { isAccountAllowed: (accountId) => Boolean(built.agentRegistry.account(accountId)) }
  );
  await manager.initialize();
  try {
    const account = built.agentRegistry.account(input.accountId);
    assertions.push({
      id: "actor.account_agent",
      passed: account?.enabled === true &&
        account.agentId === built.runtime.config.persona.defaultAgentId,
      expected: {
        accountId: input.accountId,
        agentId: built.runtime.config.persona.defaultAgentId,
        enabled: true
      },
      actual: account
        ? { accountId: account.id, agentId: account.agentId, enabled: account.enabled }
        : "not_registered"
    });
    if (assertions.some((assertion) => !assertion.passed)) {
      return {
        inbound: parsed,
        assertions,
        transport,
        session: { skipped: "account_contract_failed" }
      };
    }
    await seedConversationFixture(built, input);
    const inbound = await gateway.ingestEvent(
      event,
      { accountId: input.accountId, selfId: input.selfId },
      {
        transport,
        resolveForwardMessage: async (messageId) => (
          input.forwardMessages?.[String(messageId)] ?? {
            status: "failed",
            retcode: 1,
            data: null
          }
        )
      }
    );
    if (!inbound) throw new Error("USER_TEST_ONEBOT_EVENT_NOT_INGESTED");
    const expectedScope = input.actor.endsWith("_private") ? "private" : "user_group";
    assertions.push({
      id: "actor.parsed_scope",
      passed: inbound.scope === expectedScope,
      expected: expectedScope,
      actual: inbound.scope
    });
    built.runtime.sessionCoordinator.resume(input.accountId);
    const completion = await waitForConversationCompletion(
      built.runtime,
      userTestTimeoutMs(),
      conversationId,
      inbound.scope === "user_group"
    );
    assertions.push({
      id: "conversation.completed",
      passed: completion.completed,
      expected: "会话防抖、模型调用、工具循环与出站投递完成",
      actual: completion.completed
        ? "completed"
        : `timeout with ${completion.activeEvents.length} active event(s)`
    });
    return {
      inbound,
      assertions,
      transport,
      session: {
        conversationId,
        completion,
        events: built.runtime.sessionStore.listEvents(conversationId),
        turns: built.runtime.sessionStore.listTurns(conversationId),
        outbox: built.runtime.sessionStore.listOutbox(conversationId)
      }
    };
  } finally {
    await gateway.close();
    await manager.close();
  }
}

async function seedConversationFixture(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  input: ConversationUserTestInput
) {
  const fixture = input.fixture;
  if (!fixture) return;
  const repository = applicationDataStore(built.runtime.config);
  if (fixture.longTerm) repository.replaceMemory("long_term", fixture.longTerm);
  if (fixture.userProfiles) repository.replaceMemory("user_profile", fixture.userProfiles);
  if (fixture.workingMemory) {
    await seedWorkingMemoryFixture(built, fixture.workingMemory);
  }
  if (fixture.air != null) {
    const current = await readAirKnowledge(built.runtime.config);
    const result = await replaceAirKnowledge(
      built.runtime.config,
      current.revision,
      fixture.air
    );
    if (result.status === "conflict") {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_AIR_CONFLICT");
    }
  }
  if (fixture.workbenchFiles?.length) {
    const agentWorkspace = resolveProjectPath(built.runtime.config.persona.agentWorkspace);
    if (!agentWorkspace) throw new Error("USER_TEST_CONVERSATION_FIXTURE_WORKSPACE_INVALID");
    const roots = new Map<"native" | "docker", string>();
    for (const file of fixture.workbenchFiles) {
      let root = roots.get(file.backend);
      if (!root) {
        root = await resolveAgentWorkbench(agentWorkspace, file.backend);
        roots.set(file.backend, root);
      }
      await writeConversationFixtureFile(root, file.path, file.content);
    }
  }
  built.runtime.persona = await loadPersona(built.runtime.config);
}

async function writeConversationFixtureFile(
  root: string,
  relativePath: string,
  content: string
) {
  const segments = relativePath.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("USER_TEST_CONVERSATION_FIXTURE_DIRECTORY_INVALID");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(parent, { mode: 0o700 });
    }
  }
  const target = path.join(parent, segments.at(-1)!);
  try {
    await fs.writeFile(target, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_FILE_EXISTS");
    }
    throw error;
  }
}

function assertFreshConversationEvent(
  runtime: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>["runtime"],
  conversationId: string,
  inbound: ReturnType<typeof parseOneBotInboundMessage> & object
) {
  const incomingKey = persistentIncomingKey(inbound);
  const duplicate = runtime.sessionStore.listEvents(conversationId).some((event) => (
    event.dedupeKey === `reply:${incomingKey}` ||
    event.dedupeKey === `reply-debounce:${incomingKey}`
  ));
  if (duplicate) throw new Error("USER_TEST_ONEBOT_EVENT_ALREADY_USED");
}

async function waitForConversationCompletion(
  runtime: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>["runtime"],
  timeoutMs: number,
  conversationId: string,
  expectDeferredActivity: boolean
) {
  const deadline = Date.now() + timeoutMs;
  let activityObserved = !expectDeferredActivity;
  for (;;) {
    const activeEvents = [
      ...runtime.sessionCoordinator.listActiveEvents("reply_debounce"),
      ...runtime.sessionCoordinator.listActiveEvents("incoming_reply"),
      ...runtime.sessionCoordinator.listActiveEvents("tool_completion")
    ];
    const ambientActive = runtime.getConversationRecords()
      .find((record) => record.id === conversationId)
      ?.orchestratorStatus?.active === true;
    if (
      activeEvents.length > 0 ||
      ambientActive ||
      runtime.sessionStore.listEvents(conversationId).length > 0
    ) {
      activityObserved = true;
    }
    if (activeEvents.length === 0 && !ambientActive && activityObserved) break;
    if (Date.now() >= deadline) {
      return {
        completed: false as const,
        activeEvents,
        ambientActive
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await runtime.sessionCoordinator.waitForIdle({
      timeoutMs: Math.max(1_000, deadline - Date.now())
    });
    return {
      completed: true as const,
      activeEvents: [],
      ambientActive: false
    };
  } catch {
    return {
      completed: false as const,
      activeEvents: [
        ...runtime.sessionCoordinator.listActiveEvents("reply_debounce"),
        ...runtime.sessionCoordinator.listActiveEvents("incoming_reply"),
        ...runtime.sessionCoordinator.listActiveEvents("tool_completion")
      ],
      ambientActive: runtime.getConversationRecords()
        .find((record) => record.id === conversationId)
        ?.orchestratorStatus?.active === true
    };
  }
}

async function runMemoryCompressionCase(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  input: MemoryCompressionUserTestInput
) {
  const materialized = materializeMemoryCompressionAtRuntime(input, new Date());
  const runtimeInput = materialized.input;
  const repository = applicationDataStore(built.runtime.config);
  const claim: MemoryClaim = {
    conversation: runtimeInput.conversation,
    batchId: `user-test-${crypto.createHash("sha256")
      .update(JSON.stringify(runtimeInput))
      .digest("hex")
      .slice(0, 24)}`,
    messageIds: runtimeInput.messages.map((message) => message.id),
    messages: runtimeInput.messages.map((message) => ({
      ...message,
      imageCount: message.imageCount ?? 0,
      quoteCount: message.quoteCount ?? 0
    })),
    attemptMessageCount: runtimeInput.messages.length
  };
  repository.replaceMemory("long_term", runtimeInput.longTerm);
  repository.replaceMemory("user_profile", runtimeInput.userProfiles);
  const seeded = await seedWorkingMemoryFixture(built, runtimeInput.workingMemory);
  built.runtime.persona = await loadPersona(built.runtime.config);
  const before = await readWorkingMemoryDocument(built.runtime.config);
  const memoryBefore = branchMemorySnapshot(repository);
  const ok = await built.runtime.processMemoryClaim(claim);
  const after = await readWorkingMemoryDocument(built.runtime.config);
  const memoryAfter = branchMemorySnapshot(repository);
  return {
    ok,
    batchId: claim.batchId,
    seeded: {
      ...seeded,
      longTermCount: runtimeInput.longTerm.length,
      userProfileCount: runtimeInput.userProfiles.length,
      timeline: materialized.timeline
    },
    before: {
      revision: before.revision,
      itemCount: before.items.length,
      content: before.content,
      ...memoryBefore
    },
    after: {
      revision: after.revision,
      itemCount: after.items.length,
      content: after.content,
      ...memoryAfter
    }
  };
}

async function runDreamCase(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  input: DreamUserTestInput
) {
  const materialized = materializeDreamAtRuntime(
    input,
    new Date(Date.now() + 60_000)
  );
  const runtimeInput = materialized.input;
  const now = new Date(runtimeInput.now);
  const seeded = await seedDreamFixture(built, runtimeInput);
  const repository = applicationDataStore(built.runtime.config);
  const before = await readWorkingMemoryDocument(built.runtime.config);
  const memoryBefore = branchMemorySnapshot(repository);
  const run = await built.runtime.dreams.force(now);
  const after = await readWorkingMemoryDocument(built.runtime.config);
  const memoryAfter = branchMemorySnapshot(repository);
  return {
    seeded: {
      ...seeded,
      timeline: materialized.timeline
    },
    run,
    history: built.runtime.dreams.listHistory(20, now),
    workingMemory: {
      beforeRevision: before.revision,
      afterRevision: after.revision,
      beforeContent: before.content,
      afterContent: after.content
    },
    memory: {
      before: memoryBefore,
      after: memoryAfter
    },
    operationLog: repository.readMemoryOperationLogPage({ page: 1, pageSize: 100 })
  };
}

async function seedDreamFixture(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  input: DreamUserTestInput
) {
  const config = built.runtime.config;
  const repository = applicationDataStore(config);
  assertFreshDreamFixtureState(repository);
  repository.replaceMemory("long_term", input.longTerm);
  repository.replaceMemory("user_profile", input.userProfiles);
  const seededWorkingMemory = await seedWorkingMemoryFixture(built, input.workingMemory);

  const conversations: ConversationRecord[] = input.conversations.map((conversation) => {
    const messages = conversation.messages.map((message) => ({
      ...message,
      at: new Date(message.at).toISOString()
    }));
    const last = messages.at(-1)!;
    return {
      id: conversation.id,
      agentId: config.persona.defaultAgentId,
      accountId: "primary",
      scope: conversation.scope,
      title: conversation.title,
      userId: conversation.userId,
      ...(conversation.groupId == null ? {} : { groupId: conversation.groupId }),
      replyEnabled: true,
      messageCount: messages.length,
      lastAt: last.at,
      lastText: last.text,
      messages
    };
  });
  repository.replaceConversations(conversations);
  const activeTasks = input.activeTasks.map((task) => repository.scheduledTasks.create({
    id: task.id,
    name: task.name,
    enabled: true,
    schedule: { kind: "once", runAt: task.runAt },
    context: task.context,
    targets: [{
      conversationId: task.targetConversationId,
      mentionUserIds: task.mentionUserIds
    }]
  }));
  const directorSchedule = input.directorSchedule == null
    ? null
    : repository.director.commit({
        draft: input.directorSchedule,
        seedHash: crypto.createHash("sha256")
          .update(JSON.stringify(input.directorSchedule))
          .digest("hex"),
        source: "daily_plan",
        expectedRevision: 0,
        now: new Date(input.now)
      });
  const persona = await loadPersona(config, {
    "SOUL.md": input.persona.soul,
    "PREFERENCE.md": input.persona.preference,
    "USER.md": input.persona.user,
    "RELATION.md": input.persona.relation,
    "AIR.md": input.persona.air
  });
  built.runtime.persona = { ...persona, name: input.persona.name };
  return {
    workingMemoryCount: seededWorkingMemory.count,
    workingMemoryRevision: seededWorkingMemory.revision,
    longTermCount: input.longTerm.length,
    userProfileCount: input.userProfiles.length,
    conversationCount: conversations.length,
    messageCount: conversations.reduce((total, item) => total + item.messages.length, 0),
    activeTaskCount: activeTasks.length,
    directorSchedule: directorSchedule == null
      ? null
      : {
          status: directorSchedule.status,
          date: directorSchedule.schedule.date,
          revision: directorSchedule.schedule.revision
        },
    persona: {
      id: built.runtime.persona.id,
      name: built.runtime.persona.name,
      files: built.runtime.persona.files.map(({ name }) => name)
    }
  };
}

async function seedWorkingMemoryFixture(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  fixture: readonly WorkingMemoryFixtureItem[]
) {
  const config = built.runtime.config;
  const current = await readWorkingMemoryDocument(config);
  const timeZone = systemModelTimeZone();
  const workingMemory: WorkingMemoryDocumentItem[] = fixture.map((item) => ({
    id: item.id,
    content: item.content,
    recordedAt: new Date(item.recordedAt ?? item.occurredAt).toISOString(),
    timeZone: item.timeZone ?? timeZone,
    conversationId: item.conversationId,
    conversationScope: item.conversationScope,
    conversationTitle: item.conversationTitle ?? "",
    sourceKind: item.sourceKind ?? "admin",
    occurredAt: new Date(item.occurredAt).toISOString(),
    ...(item.batchId == null ? {} : { batchId: item.batchId }),
    ...(item.userId == null ? {} : { userId: item.userId }),
    ...(item.userIds == null ? {} : { userIds: item.userIds }),
    ...(item.userName == null ? {} : { userName: item.userName }),
    ...(item.addressNames == null ? {} : { addressNames: item.addressNames }),
    ...(item.occurredEndAt == null ? {} : {
      occurredEndAt: new Date(item.occurredEndAt).toISOString()
    }),
    ...(item.eventType == null ? {} : { eventType: item.eventType }),
    ...(item.subjectKey == null ? {} : { subjectKey: item.subjectKey }),
    ...(item.eventKey == null ? {} : { eventKey: item.eventKey }),
    ...(item.causalChainKey == null ? {} : { causalChainKey: item.causalChainKey }),
    ...(item.sourceMemoryIds == null ? {} : { sourceMemoryIds: item.sourceMemoryIds }),
    ...(item.memoryKind == null ? {} : { memoryKind: item.memoryKind }),
    ...(item.realityStatus == null ? {} : { realityStatus: item.realityStatus }),
    ...(item.factuality == null ? {} : { factuality: item.factuality }),
    ...(item.dreamRunId == null ? {} : { dreamRunId: item.dreamRunId }),
    ...(item.dreamDate == null ? {} : { dreamDate: item.dreamDate }),
    ...(item.dreamReviewedAt == null ? {} : {
      dreamReviewedAt: new Date(item.dreamReviewedAt).toISOString()
    })
  }));
  const replaced = await replaceWorkingMemoryDocument(
    config,
    current.revision,
    workingMemory
  );
  if (replaced.status === "conflict") throw new Error("USER_TEST_WORKING_MEMORY_CONFLICT");
  return {
    count: workingMemory.length,
    revision: replaced.current.revision
  };
}

function branchMemorySnapshot(
  repository: ReturnType<typeof applicationDataStore>
) {
  return {
    longTerm: repository.readMemory("long_term"),
    userProfiles: repository.readMemory("user_profile")
  };
}

function assertFreshDreamFixtureState(
  repository: ReturnType<typeof applicationDataStore>
) {
  const existingTasks = repository.scheduledTasks.list({ limit: 1 }).items.length;
  const existingSchedules = repository.director.list({ page: 1, pageSize: 1 }).pagination.total;
  const existingDreams = repository.dreams.listRuns({ limit: 1 }).length;
  if (existingTasks || existingSchedules || existingDreams) {
    throw new Error("USER_TEST_DREAM_WORKSPACE_NOT_FRESH");
  }
}

function userTestTimeoutMs() {
  const configured = Number(process.env.SUNABOT_USER_TEST_TIMEOUT_MS ?? 300_000);
  return Number.isSafeInteger(configured) && configured >= 5_000 && configured <= 1_800_000
    ? configured
    : 300_000;
}

function blockedError(error: unknown) {
  return /UNAVAILABLE|NOT_CONFIGURED|NO PROVIDER|API KEY|AUTH|ECONNREFUSED|ENOTFOUND|TIMEOUT/iu
    .test(stableError(error));
}

function stableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:[A-Za-z]:\\|\/)[^\s"'`]+/gu, "[path]").slice(0, 2_000);
}

function assertionTextValues(
  kind: UserTestCase["kind"],
  observation: UserTestRunReport["observation"]
) {
  if (kind === "conversation") {
    return extractConversationUserFacingTextValues(observation.outbound);
  }
  const branch = recordValue(observation.branch);
  if (kind === "memory_compression") {
    return [recordValue(branch?.after)?.content];
  }
  const run = recordValue(branch?.run);
  const workingMemory = recordValue(branch?.workingMemory);
  return [run?.dreamText, run?.output, workingMemory?.afterContent];
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function currentSourceRevision() {
  const result = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8"
  });
  const revision = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("USER_TEST_SOURCE_REVISION_INVALID");
  return revision;
}
