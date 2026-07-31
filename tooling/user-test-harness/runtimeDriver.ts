import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { AgentToolName, AppConfig } from "../../packages/contracts/admin/public.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import { readRequestLogs } from "../../adapters/observability/requestLog.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { resolveProjectPath } from "../../packages/platform/projectPaths.js";
import { runWithAgentRuntimeContext } from "../../packages/platform/runtimeAgentContext.js";
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
import { appendConversationMessage } from "../../src/runtime/conversationMemoryHelpers.js";
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
  assertUserTestWorkspace,
  installIsolatedCodexGuiHome,
  isProviderRouteLockMarker,
  resetUserTestKnowledgeDirectory
} from "./workspace.js";
import {
  evaluateHarnessAssertions,
  evaluateProviderEvidence,
  extractCalledToolNames,
  extractConversationUserFacingTextValues,
  extractToolCallObservations,
  validateConversationActor
} from "./assertions.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BLOCKED_EXTERNAL_TOOL_EXECUTIONS = [
  "websearch",
  "webfetch",
  "generate_img",
  "selfie",
  "send_voice_message"
] as const satisfies readonly AgentToolName[];

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
  let restoreCodexGuiHome = () => undefined;
  try {
    const workspace = String(process.env.SUNABOT_WORKSPACE ?? "").trim();
    if (workspace) await assertUserTestWorkspace(workspace);
    restoreCodexGuiHome = await installIsolatedCodexGuiHome();
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
    await installProviderEgressLock(built.runtime);
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
      observation.inboundAttachments = result.inboundAttachments;
      observation.attachmentResolutions = result.transport.attachmentResolutionCalls;
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
    observation.requestLogs = (await readRequestLogs({
      config: built.runtime.config,
      limit: 500
    }))
      .filter((entry) => Date.parse(String((entry as Record<string, unknown>).at ?? "")) >= requestLogStart);
    observation.toolCalls = extractToolCallObservations(observation.requestLogs);
    observation.tools = extractCalledToolNames(observation.requestLogs);
    assertions.push(...evaluateProviderEvidence(observation.requestLogs));
    assertions.push(...evaluateHarnessAssertions({
      expected: testCase.expected,
      toolCalls: observation.toolCalls,
      outbound: observation.outbound,
      inboundAttachments: observation.inboundAttachments,
      requestLogs: observation.requestLogs,
      textValues: assertionTextValues(testCase.kind, observation)
    }));
    if (assertions.some((assertion) => !assertion.passed)) executionStatus = "failed";
  } catch (error) {
    executionStatus = blockedError(error) ? "blocked" : "failed";
    executionError = stableError(error);
  } finally {
    await built?.app.close().catch(() => undefined);
    restoreCodexGuiHome();
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

export async function installProviderEgressLock(
  runtime: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>["runtime"],
  environment: NodeJS.ProcessEnv = process.env
) {
  const workspace = environment.SUNABOT_WORKSPACE;
  if (!workspace) return;
  const marker = JSON.parse(await fs.readFile(
    path.join(workspace, ".sunabot-user-test-workspace.json"),
    "utf8"
  )) as Record<string, unknown>;
  const routeLock = marker.providerRouteLock;
  if (!isProviderRouteLockMarker(routeLock)) return;
  const blockedByHarness = marker.codexAuthCopied === true
    ? BLOCKED_EXTERNAL_TOOL_EXECUTIONS
    : [...BLOCKED_EXTERNAL_TOOL_EXECUTIONS, "codex"] as const;
  const original = runtime.completePromptTurn.bind(runtime);
  runtime.completePromptTurn = ((provider, request, options = {}) => original(
    provider,
    request,
    {
      ...options,
      blockedToolExecutions: [
        ...new Set([
          ...(options.blockedToolExecutions ?? []),
          ...blockedByHarness
        ])
      ]
    }
  )) as typeof runtime.completePromptTurn;
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
        accountId: input.accountId,
        attachmentSources: input.fixture?.attachmentSources
      }),
      inboundAttachments: [],
      session: { skipped: "actor_contract_failed" }
    };
  }
  ensureConversationFixtureAccount(built, input);
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
    accountId: input.accountId,
    attachmentSources: input.fixture?.attachmentSources
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
        inboundAttachments: [],
        session: { skipped: "account_contract_failed" }
      };
    }
    await seedConversationFixture(built, input, parsed);
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
    for (const source of input.fixture?.attachmentSources ?? []) {
      const calls = transport.attachmentResolutionCalls.filter(
        (call) => call.fileId === source.fileId
      );
      assertions.push({
        id: `attachment.account:${source.fileId}`,
        passed: calls.some((call) => (
          call.accountId === input.accountId &&
          call.strategy === "resolve" &&
          call.outcome === "resolved"
        )) && calls.every((call) => call.accountId === input.accountId),
        expected: {
          accountId: input.accountId,
          fileId: source.fileId,
          strategy: "resolve",
          outcome: "resolved"
        },
        actual: calls
      });
    }
    const completedRecord = built.runtime.getConversationRecords()
      .find((record) => record.id === conversationId);
    const completedMessage = completedRecord?.messages
      .find((message) => message.id === String(inbound.messageId));
    const inboundAttachments = (completedMessage?.attachments ?? []).map(
      (attachment, index) => ({
        messageId: String(inbound.messageId),
        index,
        name: attachment.name,
        status: attachment.status,
        ...(attachment.acquisition ? {
          acquisitionStatus: attachment.acquisition.status
        } : {}),
        ...(attachment.parseStatus ? { parseStatus: attachment.parseStatus } : {}),
        ...(attachment.acquisition?.status === "acquired" ? {
          blobSha256: attachment.acquisition.blob.sha256,
          blobSizeBytes: attachment.acquisition.blob.sizeBytes,
          ...(attachment.acquisition.blob.detectedMimeType
            ? { blobMimeType: attachment.acquisition.blob.detectedMimeType }
            : {})
        } : {}),
        ...(attachment.format ? { format: attachment.format } : {}),
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.sizeBytes == null ? {} : { sizeBytes: attachment.sizeBytes }),
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        ...(attachment.pageCount == null ? {} : { pageCount: attachment.pageCount }),
        handle: `message:${String(inbound.messageId)}:file:${index}`
      })
    );
    return {
      inbound,
      assertions,
      transport,
      inboundAttachments,
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

function ensureConversationFixtureAccount(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  input: ConversationUserTestInput
) {
  if (built.agentRegistry.account(input.accountId)) return;
  const agentId = built.runtime.config.persona.defaultAgentId;
  const repository = [
    applicationDataStore(built.getConfig()),
    applicationDataStore(built.runtime.config)
  ].find((candidate) => candidate.readAgent(agentId));
  if (!repository) throw new Error("USER_TEST_FIXTURE_AGENT_NOT_REGISTERED");
  const createdAt = new Date().toISOString();
  try {
    repository.createAgentAccount({
      id: input.accountId,
      agentId,
      label: "User test fixture",
      qqId: input.selfId,
      enabled: true,
      webuiPort: repository.nextAgentAccountWebuiPort(),
      createdAt,
      updatedAt: createdAt
    });
  } catch (error) {
    throw new Error(
      `USER_TEST_FIXTURE_ACCOUNT_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function seedConversationFixture(
  built: Awaited<ReturnType<typeof import("../../apps/api/server.js")["buildApp"]>>,
  input: ConversationUserTestInput,
  incoming: NonNullable<ReturnType<typeof parseOneBotInboundMessage>>
) {
  const fixture = input.fixture;
  if (!fixture) return;
  const repository = applicationDataStore(built.runtime.config);
  if (fixture.longTerm) repository.replaceMemory("long_term", fixture.longTerm);
  if (fixture.userProfiles) repository.replaceMemory("user_profile", fixture.userProfiles);
  if (fixture.workingMemory) {
    await seedWorkingMemoryFixture(built, fixture.workingMemory);
  }
  if (fixture.conversationMessages) {
    const lastFixtureMessage = fixture.conversationMessages.at(-1);
    if (!lastFixtureMessage) {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_MESSAGES_INVALID");
    }
    const record = built.runtime.ensureConversationRecord(incoming, incoming.time);
    if (record.messageCount !== 0 || record.messages.length !== 0) {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_NOT_FRESH");
    }
    const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
    if (
      currentMessageId &&
      fixture.conversationMessages.some((message) => message.id === currentMessageId)
    ) {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_MESSAGE_ID_COLLISION");
    }
    if (
      Date.parse(lastFixtureMessage.at) >= Date.parse(incoming.time)
    ) {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_TIME_INVALID");
    }
    for (const message of fixture.conversationMessages) {
      appendConversationMessage(record, {
        id: message.id,
        role: message.role,
        text: message.text,
        at: message.at,
        sequence: message.sequence,
        ...(message.userId == null ? {} : {
          userId: message.userId,
          isAdmin: built.runtime.isAdminUser(message.userId)
        }),
        ...(incoming.groupId == null ? {} : { groupId: incoming.groupId }),
        ...(message.senderName == null ? {} : { senderName: message.senderName }),
        selfId: incoming.selfId
      });
    }
    record.memoryCompressedThroughMessageCount = record.messageCount;
    if (record.scope === "user_group") {
      record.orchestratorCheckedMessageCount = record.messageCount;
    }
    built.runtime.persistConversationRecords();
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
  if (fixture.resetKnowledge?.length || fixture.workbenchFiles?.length) {
    const agentWorkspace = resolveProjectPath(built.runtime.config.persona.agentWorkspace);
    if (!agentWorkspace) throw new Error("USER_TEST_CONVERSATION_FIXTURE_WORKSPACE_INVALID");
    const roots = new Map<"native" | "docker", string>();
    for (const backend of fixture.resetKnowledge ?? []) {
      let root = roots.get(backend);
      if (!root) {
        root = await resolveAgentWorkbench(agentWorkspace, backend);
        roots.set(backend, root);
      }
      await resetUserTestKnowledgeDirectory(
        String(process.env.SUNABOT_WORKSPACE ?? ""),
        root
      );
    }
    for (const file of fixture.workbenchFiles ?? []) {
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
  const personaBefore = await dreamPersonaFileSnapshot(built.runtime.config);
  const run = await runWithAgentRuntimeContext(
    built.runtime.config,
    () => built.runtime.dreams.force(now)
  );
  const after = await readWorkingMemoryDocument(built.runtime.config);
  const memoryAfter = branchMemorySnapshot(repository);
  const personaAfter = await dreamPersonaFileSnapshot(built.runtime.config);
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
    personaFiles: {
      before: personaBefore,
      after: personaAfter
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
  await seedDreamPersonaFiles(config, input.persona);
  const persona = await loadPersona(config);
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

async function seedDreamPersonaFiles(
  config: AppConfig,
  persona: DreamUserTestInput["persona"]
) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("USER_TEST_DREAM_PERSONA_WORKSPACE_INVALID");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await Promise.all([
    ["SOUL.md", persona.soul],
    ["PREFERENCE.md", persona.preference],
    ["USER.md", persona.user],
    ["RELATION.md", persona.relation]
  ].map(([fileName, content]) => fs.writeFile(
    path.join(workspace, fileName!),
    `${content!.trim()}\n`,
    { encoding: "utf8", mode: 0o600 }
  )));
  if (persona.air.trim()) {
    const current = await readAirKnowledge(config);
    const replaced = await replaceAirKnowledge(config, current.revision, persona.air);
    if (replaced.status === "conflict") throw new Error("USER_TEST_DREAM_AIR_CONFLICT");
  }
}

async function dreamPersonaFileSnapshot(config: AppConfig) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("USER_TEST_DREAM_PERSONA_WORKSPACE_INVALID");
  const read = async (fileName: string) => {
    const content = await fs.readFile(path.join(workspace, fileName), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    return {
      content,
      revision: crypto.createHash("sha256").update(content).digest("hex")
    };
  };
  const [preference, relation, air] = await Promise.all([
    read("PREFERENCE.md"),
    read("RELATION.md"),
    readAirKnowledge(config)
  ]);
  return {
    preference,
    relation,
    air: {
      content: air.content,
      revision: air.revision
    }
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
  const personaFiles = recordValue(branch?.personaFiles);
  const afterPersona = recordValue(personaFiles?.after);
  return [
    run?.dreamText,
    run?.output,
    workingMemory?.afterContent,
    recordValue(afterPersona?.air)?.content,
    recordValue(afterPersona?.preference)?.content,
    recordValue(afterPersona?.relation)?.content
  ];
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
