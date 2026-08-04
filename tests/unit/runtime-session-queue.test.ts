// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunner, CodexToolResult } from "../../adapters/codex/codexTool.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { RuntimeToolCapabilityResolver } from "../../services/tools/bashCapability.js";
import type {
  OpenAIProvider,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "../../adapters/model/openaiProvider.js";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import {
  incomingReplyEnvelope,
  toolCompletionEnvelope,
  type AsyncToolCompletionPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import { scheduledCallbackDeliveryEnvelope } from "../../packages/contracts/session/scheduledTaskRuntimeMessages.js";
import { buildCallbackInput } from "../../services/agent/callbackInput.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import {
  renderFinalPromptTemplate,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import type { MemoryEntry } from "../../services/memory/types.js";
import { SunaRuntime } from "../../src/runtime.js";
import type { ReplyDelivery } from "../../src/runtime/runtimeContracts.js";
import type { OutboxDeliveryContext } from "../../services/sessions/sessionCoordinator.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import { sendFileTool } from "../../services/tools/sendConversationAssetTool.js";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";
import { replyDebounceSessionId } from "../../src/runtime/replyDebounce.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";
import { runtime_generateImgReferenceContext } from "../../src/runtime/replyContext.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const recallMemory = vi.hoisted(() => vi.fn(async () => ({ ok: true, matches: [] })));
const readUserProfileForUser = vi.hoisted(() => vi.fn(async () => undefined));
const archiveConversationImage = vi.hoisted(() => vi.fn(async (
  agentId: string,
  prepared: { sha256?: string }
) => `/generated-images/conversation-assets/agents/${agentId}/${prepared.sha256}.png`));

vi.mock("../../adapters/observability/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/observability/requestLog.js")>()),
  appendRequestLog
}));
vi.mock("../../services/memory/memoryService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/memory/memoryService.js")>()),
  recallMemory,
  readUserProfileForUser
}));
vi.mock("../../services/media/conversationImageArchive.js", () => ({
  archiveConversationImage
}));

const runtimes: SunaRuntime[] = [];
const stores: SessionStore[] = [];
const runtimeRoots: string[] = [];
let runtimeRootSequence = 0;

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
  closeApplicationDataStores();
  for (const root of runtimeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SunaRuntime Session queue bridge", () => {
  it("keeps the first inbound conversation closed without an explicit test enablement", async () => {
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "unused"
    }));
    const harness = createRuntimeHarness(
      completeRequestTurn,
      undefined,
      undefined,
      undefined,
      0,
      false
    );

    await handleOneBotEvent(harness.runtime, privateEvent(19_998, "保持关闭"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).not.toHaveBeenCalled();
    expect(runtimeConversation(harness.runtime, "private:171419991")).toMatchObject({
      replyEnabled: false,
      messageCount: 1
    });
  });

  it("passes the shared normal reply retry limit to the provider request", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.modelRequestMaxRetries).toBe(6);
      expect(options.modelRequestAttemptTimeoutMs).toBeUndefined();
      return { kind: "completed", text: "已完成" };
    });
    const harness = createRuntimeHarness(completeRequestTurn, undefined, (config) => {
      config.normalReply.maxRetries = 6;
    });

    await handleOneBotEvent(harness.runtime, privateEvent(19_999, "检查重试设置"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentTexts(harness.gateway)).toEqual(["已完成"]);
  });

  it("gives a scheduled callback Provider request the shared 10-minute attempt budget", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.modelRequestAttemptTimeoutMs).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
      return { kind: "completed", text: "定时任务已完成" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    const sessionId = "private:171419991";
    const occurredAt = "2026-07-31T02:00:00.000Z";
    harness.runtime.activeGateway = harness.gateway;
    (harness.runtime as unknown as {
      sessionCoordinator: {
        enqueueEvent(input: Parameters<SessionStore["enqueueEvent"]>[0]): unknown;
      };
    }).sessionCoordinator.enqueueEvent({
      sessionId,
      kind: "scheduled_callback_delivery",
      dedupeKey: "scheduled-callback-budget",
      payload: scheduledCallbackDeliveryEnvelope({
        type: "scheduled_callback",
        taskId: "scheduled-budget",
        taskRevision: 1,
        runId: "scheduled-budget-run",
        taskName: "预算测试",
        scheduledFor: occurredAt,
        triggeredAt: occurredAt,
        text: buildCallbackInput("scheduled_task", {
          promptMessages: [{ role: "user", content: "执行定时任务" }]
        }),
        target: {
          conversationId: sessionId,
          accountId: "primary",
          scope: "private",
          userId: 171419991,
          mentionUserIds: []
        }
      }, {
        conversationId: sessionId,
        correlationId: "scheduled-budget-run",
        idempotencyKey: "scheduled-callback-budget",
        occurredAt
      })
    });

    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });
    await waitUntil(() => sentTexts(harness.gateway).includes("定时任务已完成"));

    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentTexts(harness.gateway)).toEqual(["定时任务已完成"]);
  });

  it.each([
    {
      label: "private",
      event: privateEvent(19_980, "发送报告"),
      accountId: undefined,
      sessionId: "private:171419991",
      workbenchDirectory: "workbench",
      target: { accountId: "primary", scope: "private", userId: 171419991 }
    },
    {
      label: "group",
      event: groupEvent(19_981, 602, "发送报告"),
      accountId: "account-b",
      sessionId: "account:account-b:group:602",
      workbenchDirectory: "docker-workbench",
      target: { accountId: "account-b", scope: "user_group", userId: 171419991, groupId: 602 }
    }
  ])("queues send_file for the current $label conversation and account", async ({
    event,
    accountId,
    sessionId,
    workbenchDirectory,
    target
  }) => {
    expect(parseOneBotInboundMessage(event)?.transport).toBeUndefined();
    const harness = createRuntimeHarness(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.conversationAssets?.enabled).toBe(true);
      options.onToolCall?.("send_file");
      await expect(options.conversationAssets!.send({
        path: "exports/report.txt",
        kind: "file"
      }, {
        callId: `call-send-file-${accountId ?? "primary"}`,
        toolName: "send_file"
      })).resolves.toMatchObject({
        ok: true,
        queued: true,
        kind: "file",
        name: "report.txt",
        byteLength: 6
      });
      return { kind: "completed", text: "文件已发送" };
    });
    const workbench = path.join(
      harness.runtime.config.persona.agentWorkspace,
      workbenchDirectory,
      "exports"
    );
    fs.mkdirSync(workbench, { recursive: true });
    fs.writeFileSync(path.join(workbench, "report.txt"), "report");

    await handleOneBotEvent(harness.runtime, event, harness.gateway, accountId);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const sendConversationAsset = harness.gateway.sendConversationAsset as unknown as ReturnType<typeof vi.fn>;
    expect(sendConversationAsset).toHaveBeenCalledOnce();
    expect(sendConversationAsset).toHaveBeenCalledWith({
      ...target,
      asset: expect.objectContaining({
        kind: "file",
        name: "report.txt",
        source: `base64://${Buffer.from("report").toString("base64")}`,
        byteLength: 6
      })
    });
    expect(harness.store.listOutbox(sessionId).map((outbox) => outbox.kind)).toContain(
      "onebot.conversation_asset"
    );
    expect(harness.store.listOutbox(sessionId).find((outbox) => outbox.kind === "onebot.conversation_asset"))
      .toMatchObject({ deliveryPartition: accountId ?? "primary" });
    expect(sentTexts(harness.gateway)).toEqual(["文件已发送"]);
  });

  it("projects a successfully sent workbench image into reusable assistant history", async () => {
    archiveConversationImage.mockClear();
    const harness = createRuntimeHarness(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      await options.conversationAssets!.send({
        path: "exports/reference.png",
        kind: "image"
      }, {
        callId: "call-send-reference-image",
        toolName: "send_file"
      });
      return { kind: "completed", text: "图片已发送" };
    });
    const sendConversationAsset = harness.gateway.sendConversationAsset as unknown as ReturnType<typeof vi.fn>;
    sendConversationAsset.mockResolvedValue({ accepted: true, messageId: "asset-image-9001" });
    const workbench = path.join(
      harness.runtime.config.persona.agentWorkspace,
      "workbench",
      "exports"
    );
    fs.mkdirSync(workbench, { recursive: true });
    fs.writeFileSync(path.join(workbench, "reference.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    ));

    const event = privateEvent(19_982, "把参考图发给我");
    await handleOneBotEvent(harness.runtime, event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const incoming = parseOneBotInboundMessage(event)!;
    incoming.agentId = harness.runtime.config.persona.defaultAgentId;
    incoming.accountId = "primary";
    const record = harness.runtime.conversationRecords.get(conversationRecordId(incoming))!;
    const imageMessage = record.messages.find((message) => message.id === "asset-image-9001");
    expect(imageMessage).toMatchObject({
      role: "assistant",
      text: "[图片]",
      toolNames: ["send_file"],
      imageUrls: [expect.stringMatching(
        /^\/generated-images\/conversation-assets\/agents\/plana\/[a-f0-9]{64}\.png$/
      )]
    });
    expect(archiveConversationImage).toHaveBeenCalledOnce();
    expect(harness.store.listOutbox("private:171419991").find(
      (outbox) => outbox.kind === "onebot.conversation_asset"
    )?.remoteReceipt).toMatchObject({
      accepted: true,
      messageId: "asset-image-9001",
      conversationImageUrl: imageMessage?.imageUrls?.[0]
    });
    const references = runtime_generateImgReferenceContext.call(
      harness.runtime as never,
      { ...incoming, messageId: 19_983 },
      record.messageCount + 1
    );
    expect(references.mediaByHandle).toHaveProperty(
      "message:asset-image-9001:image:0",
      imageMessage?.imageUrls?.[0]
    );
  });

  it("lets an administrator private turn return a file created by explicit Docker Bash", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      await expect(options.conversationAssets!.send({
        path: "exports/docker-report.txt",
        kind: "file"
      }, {
        callId: "call-admin-docker-send-file",
        toolName: "send_file"
      })).resolves.toMatchObject({
        ok: true,
        queued: true,
        name: "docker-report.txt"
      });
      return { kind: "completed", text: "文件已发送" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    const dockerWorkbench = path.join(
      harness.runtime.config.persona.agentWorkspace,
      "docker-workbench",
      "exports"
    );
    fs.mkdirSync(dockerWorkbench, { recursive: true });
    fs.writeFileSync(path.join(dockerWorkbench, "docker-report.txt"), "docker report");

    await handleOneBotEvent(harness.runtime, privateEvent(19_983, "使用 Docker 生成并发送报告"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.gateway.sendConversationAsset).toHaveBeenCalledOnce();
    expect(harness.gateway.sendConversationAsset).toHaveBeenCalledWith(expect.objectContaining({
      scope: "private",
      asset: expect.objectContaining({
        name: "docker-report.txt",
        source: `base64://${Buffer.from("docker report").toString("base64")}`
      })
    }));
  });

  it.each([
    {
      label: "ordinary private",
      event: privateEvent(19_984, "发送 Native 文件", 998_104)
    },
    {
      label: "ordinary group",
      event: groupEvent(19_985, 603, "发送 Native 文件", 998_105)
    }
  ])("does not let an $label turn fall back from Docker to the Native workbench", async ({ event }) => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      await expect(options.conversationAssets!.send({
        path: "exports/native-only.txt",
        kind: "file"
      }, {
        callId: "call-ordinary-native-send-file",
        toolName: "send_file"
      })).rejects.toMatchObject({ code: "SEND_FILE_SOURCE_MISSING" });
      return { kind: "completed", text: "文件不可用" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    const nativeWorkbench = path.join(
      harness.runtime.config.persona.agentWorkspace,
      "workbench",
      "exports"
    );
    fs.mkdirSync(nativeWorkbench, { recursive: true });
    fs.writeFileSync(path.join(nativeWorkbench, "native-only.txt"), "native only");

    await handleOneBotEvent(harness.runtime, event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.gateway.sendConversationAsset).not.toHaveBeenCalled();
  });

  it("delivers send_file after preparation mutates non-identity incoming fields", async () => {
    const harness = createRuntimeHarness(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.conversationAssets?.enabled).toBe(true);
      await expect(options.conversationAssets!.send({
        path: "exports/report.txt",
        kind: "file"
      }, {
        callId: "call-prepared-send-file",
        toolName: "send_file"
      })).resolves.toMatchObject({ ok: true, queued: true });
      return { kind: "completed", text: "文件已发送" };
    });
    const internals = harness.runtime as unknown as {
      prepareIncomingMessage(incoming: Record<string, any>, gateway: MessagingPort): Promise<void>;
      attachmentService: {
        buildModelContext(attachments: unknown[]): Promise<{
          text: string;
          localImagePaths: string[];
          attachments: unknown[];
        }>;
      };
    };
    internals.attachmentService = {
      buildModelContext: async (attachments) => ({ text: "", localImagePaths: [], attachments })
    };
    internals.prepareIncomingMessage = async (incoming) => {
      incoming.sender = {
        ...incoming.sender,
        nickname: "prepared-nickname",
        displayName: "prepared-display-name"
      };
      incoming.media = [{
        schemaVersion: 1,
        kind: "image",
        source: "inline_data",
        url: "data:image/png;base64,cHJlcGFyZWQ="
      }];
      incoming.attachments = [{
        id: "prepared-attachment",
        source: "message",
        name: "prepared.pdf",
        status: "ready",
        chunkIndexPath: "/private/prepared/chunks.sqlite"
      }];
      incoming.quoteReferences = [{
        messageId: 19_970,
        text: "prepared quote",
        imageUrls: ["https://private.example.invalid/prepared.png"]
      }];
    };
    const workbench = path.join(harness.runtime.config.persona.agentWorkspace, "workbench", "exports");
    fs.mkdirSync(workbench, { recursive: true });
    fs.writeFileSync(path.join(workbench, "report.txt"), "report");
    const event = privateEvent(19_982, "发送准备后的报告");
    expect(parseOneBotInboundMessage(event)?.transport).toBeUndefined();

    await handleOneBotEvent(harness.runtime, event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.gateway.sendConversationAsset).toHaveBeenCalledOnce();
    expect(harness.store.listOutbox("private:171419991").find((outbox) => (
      outbox.kind === "onebot.conversation_asset"
    ))).toMatchObject({ status: "sent", deliveryPartition: "primary" });
  });

  it("finishes a no_reply turn without outbound text or a placeholder assistant message", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.allowNoReply).toBe(true);
      options.onToolCall?.("no_reply");
      return { kind: "no_reply" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);

    await handleOneBotEvent(harness.runtime, privateEvent(20_000, "话题到这里就好"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(sentTexts(harness.gateway)).toEqual([]);
    expect(harness.gateway.poke).not.toHaveBeenCalled();
    expect(harness.store.listTurns("private:171419991").map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(runtimeConversation(harness.runtime, "private:171419991")?.messages.map((message) => ({
      role: message.role,
      text: message.text,
      requestStatus: message.requestStatus
    }))).toEqual([{
      role: "user",
      text: "话题到这里就好",
      requestStatus: undefined
    }]);
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
      category: "runtime.action",
      action: "reply.no_reply",
      response: { status: "no_reply" }
    }));
  });

  it.each([
    {
      scope: "private",
      event: privateEvent(20_010, "不用继续回复"),
      sessionId: "private:171419991",
      accountId: undefined,
      target: { accountId: "primary", userId: 171419991 }
    },
    {
      scope: "group",
      event: groupEvent(20_011, 602, "不用继续回复"),
      sessionId: "account:account-b:group:602",
      accountId: "account-b",
      target: { accountId: "account-b", userId: 171419991, groupId: 602 }
    }
  ])("delivers a durable poke for a no_reply $scope turn when enabled", async ({ event, sessionId, accountId, target }) => {
    const harness = createRuntimeHarness(async () => ({ kind: "no_reply" }), undefined, (config) => {
      config.bot.pokeOnNoReply = true;
    });

    await handleOneBotEvent(harness.runtime, event, harness.gateway, accountId);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(sentTexts(harness.gateway)).toEqual([]);
    expect(harness.gateway.poke).toHaveBeenCalledOnce();
    expect(harness.gateway.poke).toHaveBeenCalledWith(target);
    expect(harness.store.listTurns(sessionId).map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(harness.store.listOutbox(sessionId)[0]).toMatchObject({
      deliveryPartition: accountId ?? "primary",
      status: "sent"
    });
    expect(runtimeConversation(harness.runtime, sessionId)?.messages.some((message) => message.role === "assistant")).toBe(false);
    expect(applicationDataStore(harness.runtime.config).readRequestLogs({ query: "", limit: 100 }))
      .toContainEqual(expect.objectContaining({
        category: "runtime.action",
        action: "reply.no_reply.poke.sent",
        response: { status: "sent" }
      }));
  });

  it("injects recalled working memory and the exact current-user profile into the Provider request", async () => {
    const workingMemory = memoryEntry({
      id: "working-current",
      source: "working",
      sourceTitle: "工作记忆",
      text: "猫老师正在检查记忆端点。"
    });
    const exactUserProfile = memoryEntry({
      id: "profile-current",
      source: "user_profile",
      sourceTitle: "用户画像",
      text: "喜欢验证真实运行链路。",
      userId: "171419991",
      userName: "猫老师",
      addressNames: ["猫老师"]
    });
    readUserProfileForUser.mockImplementationOnce(async () => exactUserProfile as never);
    recallMemory
      .mockImplementationOnce(async () => ({ ok: true, query: "current", matches: [] }) as never)
      .mockImplementationOnce(async () => ({ ok: true, query: "current", matches: [workingMemory] }) as never)
      .mockImplementationOnce(async () => ({ ok: true, query: "current", matches: [] }) as never);

    let providerRequest: RenderedPromptRequest | undefined;
    const harness = createRuntimeHarness(async (request) => {
      providerRequest = request;
      return { kind: "completed", text: "memory injected" };
    });
    (harness.runtime as unknown as {
      renderPromptRequest(id: string, variables: Record<string, unknown>): Promise<RenderedPromptRequest>;
    }).renderPromptRequest = async (id, variables) => {
      expect(id).toBe("conversation.private-reply");
      return renderFinalPromptTemplate(defaultFinalPromptTemplate(id)!, {
        "persona.agents": "",
        "persona.soul": "",
        "persona.preference": "",
        "persona.dialogue_style_examples": "",
        "persona.user": "",
        "persona.relation": "",
        "persona.air": "",
        ...variables
      });
    };

    await handleOneBotEvent(harness.runtime, privateEvent(20_001, "memory endpoint"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const endpointInput = lastUserText(providerRequest!);
    expect(endpointInput).toContain("<working_memory>工作记忆：猫老师正在检查记忆端点。</working_memory>");
    expect(endpointInput).toContain("<user_profile>用户画像 猫老师（QQ 171419991）：喜欢验证真实运行链路。</user_profile>");
  });

  it("routes private and group replies to independent prompt families", async () => {
    const promptIds: string[] = [];
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "routed" }));
    const internals = harness.runtime as unknown as {
      renderPromptRequest(id: string, variables: Record<string, unknown>): Promise<RenderedPromptRequest>;
    };
    internals.renderPromptRequest = async (id, variables) => {
      promptIds.push(id);
      return {
        messages: [
          { role: "system", content: id },
          { role: "user", content: String(variables["user.input"] ?? "") }
        ],
        response_format: { type: "text" }
      };
    };

    await handleOneBotEvent(harness.runtime, privateEvent(20_002, "private endpoint"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });
    await handleOneBotEvent(harness.runtime, groupEvent(20_003, 602, "group endpoint"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(promptIds).toEqual([
      "conversation.private-reply",
      "conversation.group-reply"
    ]);
  });

  it("keeps the complete ordered group context in the main reply", async () => {
    const mainRequests: RenderedPromptRequest[] = [];
    const completeRequestTurn = vi.fn(async (request: RenderedPromptRequest): Promise<ProviderTurnResult> => {
      mainRequests.push(request);
      return { kind: "completed", text: `raw reply ${mainRequests.length}` };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    const internals = harness.runtime as unknown as {
      renderPromptRequest(id: string, variables: Record<string, unknown>): Promise<RenderedPromptRequest>;
    };
    internals.renderPromptRequest = async (id, variables) => {
      return {
        messages: [
          { role: "system", content: id },
          ...((variables["messages_64"] ?? []) as RenderedPromptRequest["messages"]),
          { role: "user", content: String(variables["user.input"] ?? "") }
        ],
        response_format: { type: "text" }
      };
    };

    await handleOneBotEvent(harness.runtime, groupEvent(20_004, 603, "first raw message"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });
    await handleOneBotEvent(harness.runtime, groupEvent(20_005, 603, "second raw message"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(sentTexts(harness.gateway)).toEqual(["raw reply 1", "raw reply 2"]);
    const secondRequest = mainRequests[1]!;
    const firstHistoryIndex = secondRequest.messages.findIndex((message) => message.content.includes("message_id=20004"));
    const assistantHistoryIndex = secondRequest.messages.findIndex((message) => message.content.includes("raw reply 1"));
    const currentInputIndex = secondRequest.messages.findLastIndex((message) => message.role === "user");
    expect(firstHistoryIndex).toBeGreaterThan(0);
    expect(assistantHistoryIndex).toBeGreaterThan(firstHistoryIndex);
    expect(currentInputIndex).toBeGreaterThan(assistantHistoryIndex);
  });

  it("keeps model starts and sends FIFO in one group while another group progresses", async () => {
    const gates = new Map([
      ["first", deferred<void>()],
      ["second", deferred<void>()],
      ["third", deferred<void>()],
      ["parallel", deferred<void>()]
    ]);
    const starts: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      const marker = findMarker(lastUserText(request), [...gates.keys()]);
      starts.push(marker);
      if (options.signal) signals.set(marker, options.signal);
      await gates.get(marker)!.promise;
      return { kind: "completed", text: `reply:${marker}` };
    });
    const harness = createRuntimeHarness(completeRequestTurn);

    await handleOneBotEvent(harness.runtime, groupEvent(101, 100, "first"), harness.gateway);
    await handleOneBotEvent(harness.runtime, groupEvent(102, 100, "second"), harness.gateway);
    await handleOneBotEvent(harness.runtime, groupEvent(103, 100, "third"), harness.gateway);
    await handleOneBotEvent(harness.runtime, groupEvent(201, 200, "parallel"), harness.gateway);

    await waitUntil(() => starts.length === 2);
    expect(starts).toEqual(["first", "parallel"]);
    expect(signals.get("first")?.aborted).toBe(false);

    gates.get("parallel")!.resolve();
    await waitUntil(() => sentTexts(harness.gateway).includes("reply:parallel"));
    expect(starts).toEqual(["first", "parallel"]);

    gates.get("first")!.resolve();
    await waitUntil(() => starts.includes("second"));
    expect(signals.get("first")?.aborted).toBe(false);

    gates.get("second")!.resolve();
    await waitUntil(() => starts.includes("third"));
    gates.get("third")!.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(starts).toEqual(["first", "parallel", "second", "third"]);
    expect(sentMessages(harness.gateway)
      .filter(([groupId]) => groupId === 100)
      .map(([, text]) => text)).toEqual([
        "reply:first",
        "reply:second",
        "reply:third"
      ]);
    expect(harness.store.listTurns("group:100").map((turn) => turn.status)).toEqual([
      "replied",
      "replied",
      "replied"
    ]);
  });

  it.each([
    "conversation_projection",
    "after_reply"
  ])("settles a remote reply once when the %s step fails locally", async (failingStep) => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const send = harness.gateway.send as unknown as ReturnType<typeof vi.fn>;
    send.mockResolvedValue({ accepted: true, messageId: "remote-9001" });
    const incoming = parseOneBotInboundMessage(privateEvent(16_000, failingStep))!;
    harness.runtime.recordIncomingMessage(incoming);
    let injected = false;
    let phase: OutboxDeliveryContext["phase"] = "send";
    let remoteReceipt: unknown;
    const completedSteps = new Set<string>();
    const context: OutboxDeliveryContext = {
      signal: new AbortController().signal,
      get phase() { return phase; },
      get remoteReceipt() { return remoteReceipt; },
      async sendRemote(operation) {
        const receipt = await operation();
        remoteReceipt = receipt;
        phase = "settle";
        return receipt;
      },
      async settleStep(step, operation) {
        if (completedSteps.has(step)) return undefined;
        const value = await operation(`outbox:test:settle:${step}`);
        completedSteps.add(step);
        return value;
      },
      async settleEffectStep(step, operation) {
        if (completedSteps.has(step)) return undefined;
        const value = await operation(`outbox:test:settle:${step}`);
        completedSteps.add(step);
        return value;
      }
    };

    if (failingStep === "conversation_projection") {
      vi.spyOn(harness.runtime, "recordAssistantMessage")
        .mockImplementationOnce(() => { throw new Error("injected:conversation_projection"); });
    } else {
      const hooks = (harness.runtime as unknown as {
        hooks: { register(name: "after_reply", id: string, handler: (payload: unknown) => unknown): void };
      }).hooks;
      hooks.register("after_reply", "audit", (payload) => {
        if (!injected) {
          injected = true;
          throw new Error("injected:after_reply");
        }
        return payload;
      });
    }

    try {
      const delivery = () => harness.runtime.deliverReplyOutbox({
        type: "assistant_reply",
        incoming,
        text: `settle:${failingStep}`,
        generatedImages: [],
        isAdmin: true,
        logRunId: "settle-run"
      }, harness.gateway, context);
      await expect(delivery()).rejects.toThrow(`injected:${failingStep}`);
      await expect(delivery()).resolves.toBeUndefined();

      expect(send).toHaveBeenCalledOnce();
      expect(remoteReceipt).toEqual({ accepted: true, messageId: "remote-9001" });
      expect([...completedSteps]).toEqual([
        "conversation_projection",
        "request_log",
        ...(failingStep === "after_reply" ? ["after_reply:audit"] : [])
      ]);
    } finally {
      appendRequestLog.mockImplementation(async () => undefined);
    }
  });

  it("keeps frozen conversations beyond top eighty during an unrelated outbox settle", async () => {
    const harness = createRuntimeHarness(
      async () => ({ kind: "completed", text: "unused" }),
      undefined,
      undefined,
      undefined,
      60_000
    );
    const activeDebounce = parseOneBotInboundMessage(
      groupEvent(16_010, 7_100, "old active debounce", 61_001)
    )!;
    await harness.runtime.handleInboundMessage(activeDebounce, harness.gateway);

    const frozenSource = parseOneBotInboundMessage(
      groupEvent(16_011, 7_101, "old frozen source", 61_002)
    )!;
    const frozenCallback = parseOneBotInboundMessage(
      groupEvent(16_012, 7_102, "old frozen callback", 61_003)
    )!;
    const queuedDeferred = parseOneBotInboundMessage(
      groupEvent(16_013, 7_103, "old queued deferred", 61_004)
    )!;
    const runningDeferred = parseOneBotInboundMessage(
      groupEvent(16_014, 7_104, "old running deferred", 61_005)
    )!;
    const oldNonprotected = parseOneBotInboundMessage(
      groupEvent(16_015, 7_105, "old nonprotected", 61_006)
    )!;
    const oldMessages = [
      activeDebounce,
      frozenSource,
      frozenCallback,
      queuedDeferred,
      runningDeferred,
      oldNonprotected
    ];
    for (const [index, incoming] of oldMessages.entries()) {
      const record = harness.runtime.recordIncomingMessage(incoming, { persist: false });
      record.lastAt = new Date(Date.UTC(2020, 0, index + 1)).toISOString();
    }

    const frozenSourceId = "group:7101";
    const sourceGate = harness.runtime.replyGates.capture(frozenSource.scope, frozenSourceId);
    harness.store.enqueueEvent({
      sessionId: frozenSourceId,
      kind: "incoming_reply",
      dedupeKey: "protected:frozen-source",
      availableAt: Date.now() + 60_000,
      payload: incomingReplyEnvelope({
        type: "incoming_reply",
        route: "direct",
        incoming: frozenSource,
        captureSequence: 1,
        contextThroughSequence: 1,
        replyGate: sourceGate,
        replyQuote: { enabled: true, replyToMessageId: frozenSource.messageId! }
      }, {
        conversationId: frozenSourceId,
        correlationId: "protected:frozen-source",
        idempotencyKey: "protected:frozen-source"
      })
    });

    const frozenCallbackId = "group:7102";
    harness.store.enqueueEvent({
      sessionId: frozenCallbackId,
      kind: "tool_completion",
      dedupeKey: "protected:frozen-callback",
      availableAt: Date.now() + 60_000,
      payload: toolCompletionEnvelope({
        type: "tool_result",
        toolJobId: "protected-tool-job",
        providerCallId: "protected-provider-call",
        toolName: "codex",
        originalRequest: {
          incoming: frozenCallback,
          captureSequence: 1,
          contextThroughSequence: 1,
          replyGate: harness.runtime.replyGates.capture(frozenCallback.scope, frozenCallbackId),
          replyQuote: { enabled: true, replyToMessageId: frozenCallback.messageId! }
        },
        arguments: {},
        outcome: { status: "succeeded", result: "done", error: null }
      }, {
        conversationId: frozenCallbackId,
        correlationId: "protected:frozen-callback",
        idempotencyKey: "protected:frozen-callback"
      })
    });

    const queuedDeferredId = "group:7103";
    const runningDeferredId = "group:7104";
    vi.spyOn(harness.store, "listToolJobs").mockReturnValue([
      { sessionId: queuedDeferredId, status: "queued" },
      { sessionId: runningDeferredId, status: "running" }
    ] as ReturnType<SessionStore["listToolJobs"]>);
    const protectedIds = new Set([
      "group:7100",
      frozenSourceId,
      frozenCallbackId,
      queuedDeferredId,
      runningDeferredId
    ]);
    expect(harness.runtime.protectedConversationIds()).toEqual(protectedIds);

    const newerIds: string[] = [];
    let settleIncoming = frozenSource;
    for (let index = 0; index < 81; index += 1) {
      const incoming = parseOneBotInboundMessage(
        groupEvent(17_000 + index, 8_000 + index, `newer conversation ${index}`, 62_000 + index)
      )!;
      const record = harness.runtime.recordIncomingMessage(incoming, { persist: false });
      record.lastAt = new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString();
      newerIds.push(record.id);
      settleIncoming = incoming;
    }

    const settleContext: OutboxDeliveryContext = {
      signal: new AbortController().signal,
      phase: "settle",
      remoteReceipt: { accepted: true, messageId: "unrelated-remote-receipt" },
      async sendRemote(operation) {
        return operation();
      },
      async settleStep(step, operation) {
        return step === "conversation_projection"
          ? operation("outbox:unrelated:conversation_projection")
          : undefined;
      },
      async settleEffectStep() {
        return undefined;
      }
    };
    await harness.runtime.deliverReplyOutbox({
      type: "assistant_reply",
      incoming: settleIncoming,
      text: "unrelated settled reply",
      generatedImages: [],
      isAdmin: false
    }, harness.gateway, settleContext);

    const persistedIds = new Set(
      applicationDataStore(harness.runtime.config).readConversations().map((record) => record.id)
    );
    expect(persistedIds.has("group:7105")).toBe(false);
    expect(persistedIds.has(newerIds[0]!)).toBe(false);
    for (const id of protectedIds) expect(persistedIds.has(id)).toBe(true);
  });

  it.each([
    "conversation_projection",
    "request_log"
  ])("deduplicates the real %s side effect when its settle checkpoint fails", async (failingStep) => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "durable reply" }));
    const completeStep = harness.store.completeOutboxSettleStep.bind(harness.store);
    let injected = false;
    vi.spyOn(harness.store, "completeOutboxSettleStep").mockImplementation((outboxId, workerId, step) => {
      if (!injected && step === failingStep) {
        injected = true;
        throw new Error(`checkpoint:${step}`);
      }
      return completeStep(outboxId, workerId, step);
    });

    await handleOneBotEvent(harness.runtime, privateEvent(16_100, failingStep), harness.gateway);
    await waitUntil(() => injected);
    await new Promise((resolve) => setTimeout(resolve, 300));
    harness.runtime.sessionCoordinator.resume();
    await waitUntil(() => {
      const outbox = harness.store.listOutbox("private:171419991")[0];
      if (outbox?.status === "delivery_unknown" || outbox?.status === "dead") {
        throw new Error(JSON.stringify(outbox));
      }
      return outbox?.status === "sent";
    }, 5_000);

    const conversationId = "private:171419991";
    expect(harness.gateway.send).toHaveBeenCalledOnce();
    expect(harness.store.listOutbox(conversationId)[0]).toMatchObject({
      status: "sent",
      completedSettleSteps: ["conversation_projection", "request_log"]
    });
    const assistantMessages = runtimeConversation(harness.runtime, conversationId)?.messages
      .filter((message) => message.role === "assistant" && message.text === "durable reply") ?? [];
    expect(assistantMessages).toHaveLength(1);

    const dataStore = applicationDataStore(harness.runtime.config);
    expect(dataStore.readRequestLogs({ query: "", limit: 100 })
      .filter((record) => record.action === "reply.sent")).toHaveLength(1);
  });

  it("quarantines an after_reply crash before the handler and resumes only after not-applied confirmation", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "hook before" }));
    let handlerRuns = 0;
    harness.runtime.hooks.register("after_reply", "audit", (payload) => {
      handlerRuns += 1;
      return payload;
    });
    const beginEffect = harness.store.beginOutboxSettleEffect.bind(harness.store);
    let injected = false;
    vi.spyOn(harness.store, "beginOutboxSettleEffect").mockImplementation((outboxId, workerId, step) => {
      const started = beginEffect(outboxId, workerId, step);
      if (!injected && step === "after_reply:audit") {
        injected = true;
        throw new Error("crash after write-ahead");
      }
      return started;
    });

    await handleOneBotEvent(harness.runtime, privateEvent(16_110, "hook-before"), harness.gateway);
    await waitUntil(() => harness.store.listOutbox("private:171419991")[0]?.status === "delivery_unknown");
    const unknown = harness.store.listOutbox("private:171419991")[0]!;
    expect(handlerRuns).toBe(0);
    expect(unknown.uncertainSettleStep).toBe("after_reply:audit");

    harness.store.resolveUnknownSettle({
      outboxId: unknown.id,
      settleStep: "after_reply:audit",
      confirmed: "not_applied"
    });
    harness.runtime.sessionCoordinator.resume();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(handlerRuns).toBe(1);
    expect(harness.store.getOutbox(unknown.id)?.status).toBe("sent");
  });

  it("does not repeat completed after_reply handlers after a later handler becomes uncertain", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "hook partial" }));
    const runs = new Map<string, number>();
    const register = (id: string, fail = false) => harness.runtime.hooks.register("after_reply", id, (payload) => {
      const key = String(payload.context.idempotencyKey ?? "");
      if (!key) throw new Error("missing idempotency key");
      if (!runs.has(key)) runs.set(key, 1);
      if (fail) throw new Error("external hook result unknown");
      return payload;
    });
    register("first");
    register("second", true);
    register("third");

    await handleOneBotEvent(harness.runtime, privateEvent(16_120, "hook-partial"), harness.gateway);
    await waitUntil(() => harness.store.listOutbox("private:171419991")[0]?.status === "delivery_unknown");
    const unknown = harness.store.listOutbox("private:171419991")[0]!;
    expect(unknown).toMatchObject({
      uncertainSettleStep: "after_reply:second",
      completedSettleSteps: expect.arrayContaining(["after_reply:first"])
    });
    expect([...runs.keys()].some((key) => key.endsWith("after_reply:third"))).toBe(false);

    harness.store.resolveUnknownSettle({
      outboxId: unknown.id,
      settleStep: "after_reply:second",
      confirmed: "applied"
    });
    harness.runtime.sessionCoordinator.resume();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.store.getOutbox(unknown.id)?.status).toBe("sent");
    expect([...runs.entries()]).toEqual(expect.arrayContaining([
      [expect.stringContaining("after_reply:first"), 1],
      [expect.stringContaining("after_reply:second"), 1],
      [expect.stringContaining("after_reply:third"), 1]
    ]));
  });

  it("quotes only the first assistant_text message and the final group reply", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      options.onToolCall?.("assistant_text");
      await options.onAssistantText?.("第一条行动消息", "assistant_text");
      options.onToolCall?.("websearch");
      options.onToolCall?.("assistant_text");
      await options.onAssistantText?.("第二条行动消息", "assistant_text");
      return { kind: "completed", text: "最终回复" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);

    await handleOneBotEvent(harness.runtime, groupEvent(150, 100, "assistant-text"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const send = harness.gateway.send as unknown as ReturnType<typeof vi.fn>;
    expect(send.mock.calls.map((call) => ({
      text: call[0].text,
      replyToMessageId: call[0].replyToMessageId
    }))).toEqual([
      { text: "第一条行动消息", replyToMessageId: 150 },
      { text: "第二条行动消息", replyToMessageId: undefined },
      { text: "最终回复", replyToMessageId: 150 }
    ]);
    expect(runtimeConversation(harness.runtime, "group:100")?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => ({
        text: message.text,
        messageOrigin: message.messageOrigin,
        toolNames: message.toolNames,
        replyMessageIds: message.replyMessageIds
      }))).toEqual([
      {
        text: "第一条行动消息",
        messageOrigin: "assistant_text",
        toolNames: ["assistant_text", "websearch"],
        replyMessageIds: [150]
      },
      {
        text: "第二条行动消息",
        messageOrigin: "assistant_text",
        toolNames: ["assistant_text", "websearch"],
        replyMessageIds: undefined
      },
      {
        text: "最终回复",
        messageOrigin: "text",
        toolNames: ["assistant_text", "websearch"],
        replyMessageIds: [150]
      }
    ]);
  });

  it("continues an inline tool round while assistant_text delivery remains in flight", async () => {
    const releaseInlineWork = deferred<void>();
    const dispatchDeliveryStarted = deferred<void>();
    const releaseDispatchDelivery = deferred<void>();
    let inlineWorkStarted = false;
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      options.onToolCall?.("assistant_text");
      await options.onAssistantText?.("正在搜索城市范围", "assistant_text");
      inlineWorkStarted = true;
      await releaseInlineWork.promise;
      options.onToolCall?.("websearch");
      return { kind: "completed", text: "搜索完成" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    const send = harness.gateway.send as unknown as ReturnType<typeof vi.fn>;
    send.mockImplementation(async (message: { text: string }) => {
      if (message.text === "正在搜索城市范围") {
        dispatchDeliveryStarted.resolve();
        await releaseDispatchDelivery.promise;
      }
      return { accepted: true as const };
    });

    await handleOneBotEvent(harness.runtime, groupEvent(150_001, 100, "inline-progress"), harness.gateway);
    await dispatchDeliveryStarted.promise;
    await waitUntil(() => inlineWorkStarted);

    expect(harness.store.listOutbox("group:100")).toHaveLength(1);
    expect(harness.store.listOutbox("group:100")[0]).toMatchObject({
      status: "sending",
      remoteSentAt: undefined
    });
    expect(harness.store.listTurns("group:100")[0]).toMatchObject({ status: "running" });

    releaseInlineWork.resolve();
    await waitUntil(() => harness.store.listOutbox("group:100").length === 2);
    expect(harness.store.listOutbox("group:100")[1]).toMatchObject({
      status: "pending",
      payload: expect.objectContaining({
        payload: expect.objectContaining({ text: "搜索完成" })
      })
    });
    releaseDispatchDelivery.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(sentTexts(harness.gateway)).toEqual(["正在搜索城市范围", "搜索完成"]);
  });

  it("does not quote messages from users in the group reply filter", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      options.onToolCall?.("assistant_text");
      await options.onAssistantText?.("处理中", "assistant_text");
      return { kind: "completed", text: "处理完成" };
    });
    const harness = createRuntimeHarness(completeRequestTurn, undefined, (config) => {
      config.bot.quoteGroupReplyExcludedUserIds = ["20002"];
    });

    await handleOneBotEvent(harness.runtime, groupEvent(151, 100, "filtered", 20_002), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const send = harness.gateway.send as unknown as ReturnType<typeof vi.fn>;
    expect(send.mock.calls.map((call) => ({
      text: call[0].text,
      replyToMessageId: call[0].replyToMessageId
    }))).toEqual([
      { text: "处理中", replyToMessageId: undefined },
      { text: "处理完成", replyToMessageId: undefined }
    ]);
  });

  it("preserves per-group FIFO without loss or duplication across 100 deterministically interleaved turns", async () => {
    const random = seededRandom(0x5eedc0de);
    const groupIds = [410, 420, 430, 440, 450];
    const expectedByGroup = new Map(groupIds.map((groupId) => [groupId, [] as string[]]));
    const startsByGroup = new Map(groupIds.map((groupId) => [groupId, [] as string[]]));
    const markerGroup = new Map<string, number>();
    const markerDelay = new Map<string, number>();
    let activeProviders = 0;
    let maximumActiveProviders = 0;
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest
    ): Promise<ProviderTurnResult> => {
      const marker = lastUserText(request).match(/job-\d{3}/)?.[0];
      if (!marker) throw new Error(`Missing property-test marker: ${lastUserText(request)}`);
      const groupId = markerGroup.get(marker);
      if (groupId == null) throw new Error(`Unknown property-test marker: ${marker}`);
      startsByGroup.get(groupId)!.push(marker);
      activeProviders += 1;
      maximumActiveProviders = Math.max(maximumActiveProviders, activeProviders);
      try {
        await delay(markerDelay.get(marker)!);
        return { kind: "completed", text: `reply:${marker}` };
      } finally {
        activeProviders -= 1;
      }
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    for (let index = 0; index < 100; index += 1) {
      const marker = `job-${String(index).padStart(3, "0")}`;
      const groupId = index < groupIds.length
        ? groupIds[index]!
        : groupIds[Math.floor(random() * groupIds.length)]!;
      markerGroup.set(marker, groupId);
      markerDelay.set(marker, 1 + Math.floor(random() * 8));
      expectedByGroup.get(groupId)!.push(marker);
      await handleOneBotEvent(harness.runtime,
        groupEvent(10_000 + index, groupId, marker),
        harness.gateway
      );
    }

    await harness.coordinator.waitForIdle({ timeoutMs: 10_000 });

    expect(completeRequestTurn).toHaveBeenCalledTimes(100);
    expect(maximumActiveProviders).toBeGreaterThan(1);
    for (const groupId of groupIds) {
      const expected = expectedByGroup.get(groupId)!;
      expect(startsByGroup.get(groupId)).toEqual(expected);
      expect(sentMessages(harness.gateway)
        .filter(([sentGroupId]) => sentGroupId === groupId)
        .map(([, text]) => text)).toEqual(expected.map((marker) => `reply:${marker}`));
      expect(harness.store.listEvents(`group:${groupId}`)).toHaveLength(expected.length);
    }
    const allSent = sentTexts(harness.gateway);
    expect(allSent).toHaveLength(100);
    expect(new Set(allSent).size).toBe(100);
  }, 20_000);

  it.each([
    { scope: "private", event: privateEvent(21_001, "retry-private"), sessionId: "private:171419991" },
    { scope: "bot_group", event: botGroupEvent(21_002, 602, "retry-bot-group"), sessionId: "group:602" },
    { scope: "user_group", event: groupEvent(21_003, 603, "retry-user-group"), sessionId: "group:603" }
  ])("retries the same $scope event after a pre-commit enqueue failure", async ({ event, sessionId }) => {
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest
    ): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: `reply:${lastUserText(request).match(/retry-[a-z-]+/)?.[0] ?? "missing"}`
    }));
    const harness = createRuntimeHarness(completeRequestTurn, undefined, (config) => {
      config.onebot.autoReplyBotGroup = true;
    });
    const enqueue = vi.spyOn(harness.store, "enqueueEvent")
      .mockImplementationOnce(() => { throw new Error("simulated sqlite commit failure"); });

    await expect(handleOneBotEvent(harness.runtime, event, harness.gateway))
      .rejects.toThrow("simulated sqlite commit failure");
    expect(harness.store.listEvents(sessionId)).toHaveLength(0);
    expect(runtimeConversation(harness.runtime, sessionId)).toMatchObject({
      replyEnabled: true,
      messageCount: 0,
      messages: []
    });

    enqueue.mockRestore();
    await handleOneBotEvent(harness.runtime, event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.store.listEvents(sessionId)).toHaveLength(1);
    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(runtimeConversation(harness.runtime, sessionId)?.messages
      .filter((message) => message.role === "user" && message.id === String(event.message_id)))
      .toHaveLength(1);
  });

  it("recovers a committed direct event with a missing conversation message and stays idempotent on redelivery", async () => {
    const event = privateEvent(22_001, "recover-missing-user");
    const incoming = parseOneBotInboundMessage(event)!;
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "reply:recovered"
    }));
    const harness = createRuntimeHarness(completeRequestTurn);
    const conversationId = conversationRecordId(incoming);
    harness.store.enqueueEvent({
      sessionId: conversationId,
      kind: "incoming_reply",
      dedupeKey: "reply:4004:private:171419991:22001",
      payload: incomingReplyEnvelope({
        type: "incoming_reply",
        route: "direct",
        incoming,
        captureSequence: 1,
        replyGate: harness.runtime.replyGates.capture(incoming.scope, conversationId),
        replyQuote: { enabled: false, replyToMessageId: null }
      }, {
        conversationId,
        correlationId: "recovered:22001",
        idempotencyKey: "reply:4004:private:171419991:22001"
      })
    });

    harness.runtime.resumeUserGroupOrchestrators(harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const record = runtimeConversation(harness.runtime, "private:171419991");
    expect(record?.messages.filter((message) => message.role === "user" && message.id === "22001"))
      .toHaveLength(1);
    expect(record?.orchestratorCheckedMessageCount).toBe(1);
    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(harness.gateway.send).toHaveBeenCalledOnce();

    runtimeSeenIncoming(harness.runtime).clear();
    await handleOneBotEvent(harness.runtime, event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(record?.messages.filter((message) => message.role === "user" && message.id === "22001"))
      .toHaveLength(1);
    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(harness.gateway.send).toHaveBeenCalledOnce();
  });

  it("keeps an id-less trigger and follow-up ordered exactly once in the Provider request", async () => {
    let providerRequest: RenderedPromptRequest | undefined;
    const harness = createRuntimeHarness(async (request) => {
      providerRequest = request;
      return { kind: "completed", text: "reply:id-less-batch" };
    }, undefined, undefined, undefined, 40);
    const trigger = privateEvent(22_101, "id-less-trigger-A");
    const followUp = privateEvent(22_102, "id-less-follow-up-B");
    delete trigger.message_id;
    delete followUp.message_id;

    await handleOneBotEvent(harness.runtime, trigger, harness.gateway);
    await delay(5);
    await handleOneBotEvent(harness.runtime, followUp, harness.gateway);
    await waitUntil(() => providerRequest != null);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    const providerText = lastUserText(providerRequest!);
    expect(providerText.indexOf("id-less-trigger-A"))
      .toBeLessThan(providerText.indexOf("id-less-follow-up-B"));
    expect(providerText.match(/id-less-trigger-A/g)).toHaveLength(1);
    expect(providerText.match(/id-less-follow-up-B/g)).toHaveLength(1);
    expect(runtimeConversation(harness.runtime, "private:171419991")?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)).toEqual([
      "id-less-trigger-A",
      "id-less-follow-up-B"
    ]);
  });

  it("invalidates a waiting scope candidate across disable and re-enable, then accepts a new candidate", async () => {
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "reply:scope-reenabled"
    }));
    const harness = createRuntimeHarness(
      completeRequestTurn,
      undefined,
      undefined,
      undefined,
      60
    );
    const oldEvent = privateEvent(22_110, "old-scope-candidate");
    const oldIncoming = parseOneBotInboundMessage(oldEvent)!;
    const conversationId = "private:171419991";
    const sourceSessionId = replyDebounceSessionId(oldIncoming);

    await handleOneBotEvent(harness.runtime, oldEvent, harness.gateway);
    harness.runtime.config.onebot.autoReplyPrivate = false;
    harness.runtime.cancelScopeReplies("private");
    harness.runtime.config.onebot.autoReplyPrivate = true;

    await waitUntil(() => harness.store.listTurns(sourceSessionId)[0]?.status === "no_reply");
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).not.toHaveBeenCalled();
    expect(sentTexts(harness.gateway)).toEqual([]);
    expect(harness.store.listOutbox(sourceSessionId)).toEqual([]);
    expect(harness.store.listOutbox(conversationId)).toEqual([]);

    await handleOneBotEvent(
      harness.runtime,
      privateEvent(22_111, "new-scope-candidate"),
      harness.gateway
    );
    await waitUntil(() => sentTexts(harness.gateway).length === 1);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentTexts(harness.gateway)).toEqual(["reply:scope-reenabled"]);
  });

  it("invalidates waiting candidates in every scope across a global disable and re-enable", async () => {
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "reply:global-reenabled"
    }));
    const harness = createRuntimeHarness(
      completeRequestTurn,
      undefined,
      (config) => {
        config.onebot.autoReplyBotGroup = true;
      },
      undefined,
      60
    );
    const oldEvents = [
      privateEvent(22_120, "old-global-private"),
      groupEvent(22_121, 622, "old-global-user-group"),
      botGroupEvent(22_122, 623, "old-global-bot-group")
    ];
    const oldIncoming = oldEvents.map((event) => parseOneBotInboundMessage(event)!);
    const sourceSessionIds = oldIncoming.map(replyDebounceSessionId);
    const conversationIds = ["private:171419991", "group:622", "group:623"];

    for (const event of oldEvents) {
      await handleOneBotEvent(harness.runtime, event, harness.gateway);
    }
    harness.runtime.config.onebot.autoReplyPrivate = false;
    harness.runtime.config.onebot.autoReplyUserGroup = false;
    harness.runtime.config.onebot.autoReplyBotGroup = false;
    harness.runtime.cancelScopeReplies("private");
    harness.runtime.cancelScopeReplies("user_group");
    harness.runtime.cancelScopeReplies("bot_group");
    harness.runtime.config.onebot.autoReplyPrivate = true;
    harness.runtime.config.onebot.autoReplyUserGroup = true;
    harness.runtime.config.onebot.autoReplyBotGroup = true;

    await waitUntil(() => sourceSessionIds.every((sessionId) => (
      harness.store.listTurns(sessionId)[0]?.status === "no_reply"
    )));
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).not.toHaveBeenCalled();
    expect(sentTexts(harness.gateway)).toEqual([]);
    for (const sessionId of sourceSessionIds) {
      expect(harness.store.listOutbox(sessionId)).toEqual([]);
    }
    for (const conversationId of conversationIds) {
      expect(harness.store.listOutbox(conversationId)).toEqual([]);
    }

    const newEvents = [
      privateEvent(22_123, "new-global-private"),
      groupEvent(22_124, 622, "new-global-user-group"),
      botGroupEvent(22_125, 623, "new-global-bot-group")
    ];
    for (const event of newEvents) {
      await handleOneBotEvent(harness.runtime, event, harness.gateway);
    }
    await waitUntil(() => sentTexts(harness.gateway).length === 3);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledTimes(3);
    expect(sentTexts(harness.gateway)).toHaveLength(3);
    expect(new Set(sentTexts(harness.gateway))).toEqual(new Set(["reply:global-reenabled"]));
  });

  it.each([
    {
      label: "successful",
      toolStatus: "succeeded" as const,
      finalReply: "tool success reply"
    },
    {
      label: "failed",
      toolStatus: "failed" as const,
      finalReply: "tool failure reply"
    }
  ])("ACKs one deferred Codex turn, runs the next turn, then handles a $label completion at the tail", async ({
    toolStatus,
    finalReply
  }) => {
    const toolGate = deferred<void>();
    const toolStarted = deferred<void>();
    const dispatchPrompts: string[] = [];
    const completionPrompts: string[] = [];
    const providerStarts: string[] = [];
    const asyncCodexFlags: Array<boolean | undefined> = [];
    const cronToolFlags: boolean[] = [];
    const attemptTimeouts: Array<number | undefined> = [];
    const runner: CodexRunner = {
      async run(input, context) {
        expect(input).toMatchObject({
          task: "perform long analysis",
          kind: "analysis",
          __sunabot_artifact_backend: "docker"
        });
        expect(context.authFile).toBe(path.join(process.cwd(), "workspace/secrets/codex/auth.json"));
        toolStarted.resolve();
        await toolGate.promise;
        if (toolStatus === "succeeded") {
          return {
            ok: true,
            status: "succeeded",
            jobId: context.jobId,
            kind: "analysis",
            content: "deep result"
          } satisfies CodexToolResult;
        }
        return {
          ok: false,
          status: "failed",
          jobId: context.jobId,
          kind: "analysis",
          error: { code: "worker_failed", message: "analysis failed" }
        } satisfies CodexToolResult;
      }
    };
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      const userText = lastUserText(request);
      asyncCodexFlags.push(options.asyncCodex);
      cronToolFlags.push(Boolean(options.cron));
      attemptTimeouts.push(options.modelRequestAttemptTimeoutMs);
      if (userText.includes("<tool_result>")) {
        providerStarts.push("tool_completion");
        completionPrompts.push(userText);
        return { kind: "completed", text: finalReply };
      }
      if (userText.includes("delegate")) {
        providerStarts.push("delegate");
        dispatchPrompts.push(userText);
        return {
          kind: "deferred",
          acknowledgement: "我收到委托，开始检查。",
          toolCall: {
            name: "codex",
            callId: "call-runtime-codex",
            arguments: { task: "perform long analysis", kind: "analysis" }
          }
        };
      }
      if (userText.includes("later")) {
        providerStarts.push("later");
        return { kind: "completed", text: "later reply" };
      }
      throw new Error(`Unexpected provider request: ${userText}`);
    });
    const harness = createRuntimeHarness(
      completeRequestTurn,
      runner,
      undefined,
      undefined,
      35
    );
    const acknowledgement = "我收到委托，开始检查。";

    await handleOneBotEvent(harness.runtime, groupEvent(301, 300, "delegate"), harness.gateway);
    await delay(10);
    const debounceFollowup = groupEvent(303, 300, "unused");
    debounceFollowup.message = "supplemental task details";
    await handleOneBotEvent(harness.runtime, debounceFollowup, harness.gateway);
    await toolStarted.promise;
    await waitUntil(() => sentTexts(harness.gateway).includes(acknowledgement));
    expect(sentTexts(harness.gateway).filter((text) => text === acknowledgement)).toHaveLength(1);
    expect(harness.store.listToolJobs("group:300")[0]?.arguments).not.toHaveProperty("dispatch_message");
    expect(harness.store.listToolJobs("group:300")[0]?.originalRequest).toMatchObject({
      captureSequence: 1,
      contextThroughSequence: 2
    });
    expect(dispatchPrompts).toHaveLength(1);
    expect(dispatchPrompts[0]!.indexOf("delegate"))
      .toBeLessThan(dispatchPrompts[0]!.indexOf("supplemental task details"));
    expect(dispatchPrompts[0]!.match(/delegate/g)).toHaveLength(1);
    expect(dispatchPrompts[0]!.match(/supplemental task details/g)).toHaveLength(1);

    await handleOneBotEvent(harness.runtime, groupEvent(302, 300, "later"), harness.gateway);
    await waitUntil(() => sentTexts(harness.gateway).includes("later reply"));
    expect(providerStarts).toEqual(["delegate", "later"]);
    expect(sentTexts(harness.gateway)).not.toContain(finalReply);

    toolGate.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(providerStarts).toEqual(["delegate", "later", "tool_completion"]);
    expect(sentTexts(harness.gateway)).toEqual([
      acknowledgement,
      "later reply",
      finalReply
    ]);
    expect(harness.store.listEvents("group:300").map((event) => [event.sequence, event.kind])).toEqual([
      [1, "incoming_reply"],
      [2, "incoming_reply"],
      [3, "tool_completion"]
    ]);
    expect(harness.store.listToolJobs("group:300")[0]).toMatchObject({
      providerCallId: "call-runtime-codex",
      status: toolStatus
    });
    expect(completionPrompts).toHaveLength(1);
    expect(completionPrompts[0]!.indexOf("delegate"))
      .toBeLessThan(completionPrompts[0]!.indexOf("supplemental task details"));
    expect(completionPrompts[0]!.match(/delegate/g)).toHaveLength(1);
    expect(completionPrompts[0]!.match(/supplemental task details/g)).toHaveLength(1);
    expect(completionPrompts[0]).toContain('"providerCallId": "call-runtime-codex"');
    expect(completionPrompts[0]).toContain(`"status": "${toolStatus}"`);
    expect(asyncCodexFlags).toEqual([true, true, true]);
    expect(cronToolFlags).toEqual([true, true, true]);
    expect(attemptTimeouts).toEqual([
      undefined,
      undefined,
      AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS
    ]);
    expect(runtimeConversation(harness.runtime, "group:300")?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => ({
        text: message.text,
        messageOrigin: message.messageOrigin,
        toolNames: message.toolNames
      }))).toEqual([
      {
        text: acknowledgement,
        messageOrigin: "async_tool_dispatch",
        toolNames: ["codex"]
      },
      {
        text: "later reply",
        messageOrigin: "text",
        toolNames: undefined
      },
      {
        text: finalReply,
        messageOrigin: "async_tool_callback",
        toolNames: ["codex"]
      }
    ]);
  });

  it("keeps a deferred image job independent from a low Codex timeout", async () => {
    const imageStarted = deferred<void>();
    const releaseImage = deferred<void>();
    let imageSignal: AbortSignal | undefined;
    const completeRequestTurn = vi.fn(async (
      request: RenderedPromptRequest
    ): Promise<ProviderTurnResult> => {
      const userText = lastUserText(request);
      if (userText.includes("<tool_result>")) {
        return { kind: "completed", text: "图片完成" };
      }
      return {
        kind: "deferred",
        acknowledgement: "图片开始生成。",
        toolCall: {
          name: "generate_img",
          callId: "call-low-codex-timeout-image",
          arguments: {
            prompt: "画一张夜空",
            size: null,
            resolution: null,
            quality: null,
            referenceImageUrls: null,
            referenceImagePaths: null,
            referenceMediaHandles: null,
            referenceImageSource: "none"
          }
        }
      };
    });
    const harness = createRuntimeHarness(completeRequestTurn, undefined, (config) => {
      config.bot.tools.codex.timeoutMs = 1;
    });
    const provider = (harness.runtime as unknown as {
      getProvider(): OpenAIProvider;
    }).getProvider();
    (provider.generateImage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _prompt: string,
        _size: string,
        _quality: string,
        _references: string[],
        _logContext: unknown,
        signal: AbortSignal
      ) => {
        imageSignal = signal;
        imageStarted.resolve();
        await releaseImage.promise;
        return { url: "/generated-images/low-codex-timeout.png" };
      }
    );

    await handleOneBotEvent(
      harness.runtime,
      privateEvent(30_090, "生成夜空图片"),
      harness.gateway
    );
    await imageStarted.promise;
    await delay(25);

    expect(imageSignal?.aborted).toBe(false);
    expect(harness.store.listToolJobs("private:171419991")[0]?.status).toBe("running");

    releaseImage.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.store.listToolJobs("private:171419991")[0]?.status).toBe("succeeded");
    expect(sentTexts(harness.gateway)).toEqual(["图片开始生成。", ""]);
    const send = harness.gateway.send as unknown as ReturnType<typeof vi.fn>;
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      text: "",
      media: [{ url: "/generated-images/low-codex-timeout.png" }]
    });
  });

  it("does not deliver an asynchronous Codex completion owned by another Agent", async () => {
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "不应发送的阿罗娜结果"
    }));
    const harness = createRuntimeHarness(completeRequestTurn);
    const incoming = parseOneBotInboundMessage(privateEvent(30_101, "阿罗娜任务"))!;
    incoming.agentId = "arona";
    incoming.accountId = "primary";
    const sessionId = conversationRecordId(incoming);
    const replyGate = harness.runtime.replyGates.capture(incoming.scope, sessionId);

    harness.coordinator.enqueueEvent({
      sessionId,
      kind: "tool_completion",
      dedupeKey: "foreign-agent-tool-completion",
      payload: toolCompletionEnvelope({
        type: "tool_result",
        toolJobId: "foreign-agent-job",
        providerCallId: "foreign-agent-call",
        toolName: "codex",
        originalRequest: {
          incoming,
          captureSequence: 1,
          contextThroughSequence: 1,
          replyGate,
          replyQuote: { enabled: true, replyToMessageId: incoming.messageId! }
        },
        arguments: { task: "foreign task", kind: "analysis" },
        outcome: {
          status: "succeeded",
          result: { content: "阿罗娜结果" },
          error: null
        }
      }, {
        conversationId: sessionId,
        correlationId: "foreign-agent-call",
        idempotencyKey: "foreign-agent-tool-completion"
      })
    });

    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).not.toHaveBeenCalled();
    expect(sentTexts(harness.gateway)).toEqual([]);
    expect(harness.store.listEvents(sessionId)).toEqual([
      expect.objectContaining({ kind: "tool_completion", status: "completed" })
    ]);
  });

  it("queues deferred voice after the acknowledgement and tool job commit without blocking either", async () => {
    const voiceGate = deferred<void>();
    const voiceStarted = deferred<void>();
    const toolGate = deferred<void>();
    const toolStarted = deferred<void>();
    const runner: CodexRunner = {
      async run(_input, context) {
        toolStarted.resolve();
        await toolGate.promise;
        return {
          ok: true,
          status: "succeeded",
          jobId: context.jobId,
          kind: "analysis",
          content: "done"
        };
      }
    };
    const harness = createRuntimeHarness(async (request): Promise<ProviderTurnResult> => {
      if (lastUserText(request).includes("<tool_result>")) return { kind: "no_reply" };
      return {
        kind: "deferred",
        acknowledgement: "语音稍后跟上，我已经开始处理。",
        toolCall: {
          name: "codex",
          callId: "call-runtime-deferred-voice",
          arguments: { task: "inspect", kind: "analysis" }
        },
        voice: {
          text: "语音稍后跟上，我已经开始处理。",
          language: "ja",
          callId: "call-runtime-deferred-voice-companion",
          toolName: "send_voice_message"
        }
      };
    }, runner);
    const voiceFile = path.join(
      harness.runtime.config.persona.agentWorkspace,
      "workbench",
      "exports",
      "deferred-voice.amr"
    );
    fs.mkdirSync(path.dirname(voiceFile), { recursive: true });
    fs.writeFileSync(voiceFile, Buffer.from("#!AMR\nvoice"));
    harness.runtime.synthesizeAndQueueVoice = vi.fn(async (voice, context) => {
      voiceStarted.resolve();
      await voiceGate.promise;
      const queued = await harness.runtime.queueConversationAsset({
        incoming: context.incoming,
        gateway: context.gateway,
        input: { path: "exports/deferred-voice.amr", kind: "voice", name: "deferred-voice.amr" },
        callId: voice.callId,
        logRunId: context.logRunId,
        isCurrent: context.isCurrent,
        delivery: context.delivery,
        toolName: "send_voice_message"
      });
      return { ok: true as const, queued };
    });

    await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_190, "deferred voice"),
      harness.gateway
    );
    await voiceStarted.promise;
    await toolStarted.promise;
    await waitUntil(() => sentTexts(harness.gateway).includes("语音稍后跟上，我已经开始处理。"));

    const sessionId = "private:171419991";
    expect(harness.store.listToolJobs(sessionId)[0]).toMatchObject({
      status: "running",
      providerCallId: "call-runtime-deferred-voice"
    });
    expect(harness.gateway.sendConversationAsset).not.toHaveBeenCalled();
    expect(harness.store.listOutbox(sessionId).map((outbox) => outbox.kind)).toEqual(["onebot.reply"]);

    voiceGate.resolve();
    await waitUntil(() => (harness.gateway.sendConversationAsset as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(harness.store.listOutbox(sessionId).map((outbox) => outbox.kind)).toEqual([
      "onebot.reply",
      "onebot.conversation_asset"
    ]);
    expect(harness.store.listOutbox(sessionId)[1]).toMatchObject({
      originTurnId: harness.store.listTurns(sessionId)[0]!.id,
      dedupeKey: expect.stringMatching(/^turn-outbox:[^:]+:1:[a-f0-9]{64}$/u)
    });
    expect(harness.gateway.sendConversationAsset).toHaveBeenCalledWith(expect.objectContaining({
      asset: expect.objectContaining({ kind: "voice", name: "deferred-voice.amr" })
    }));

    toolGate.resolve();
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });
  });

  it("persists asynchronous image callbacks with their source tool", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const incoming = parseOneBotInboundMessage(privateEvent(30_001, "生成一张自拍"))!;
    harness.runtime.recordIncomingMessage(incoming);
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const conversationId = conversationRecordId(incoming);
    const payload = {
      type: "tool_result",
      toolJobId: "job-selfie-1",
      providerCallId: "call-selfie-1",
      toolName: "selfie",
      originalRequest: {
        incoming,
        replyGate: harness.runtime.replyGates.capture(incoming.scope, conversationId),
        replyQuote: { enabled: false, replyToMessageId: null }
      },
      arguments: { scene: "图书馆" },
      outcome: {
        status: "succeeded",
        result: { image: { url: "https://example.test/selfie.png" } },
        error: undefined
      }
    } satisfies AsyncToolCompletionPayload;

    await harness.runtime.replyToToolCompletion(
      payload,
      harness.gateway,
      new AbortController().signal,
      delivery
    );

    expect(delivery.outbox).toHaveLength(1);
    expect(delivery.outbox[0]?.payload.payload).toMatchObject({
      messageOrigin: "async_tool_callback",
      toolNames: ["selfie"]
    });
    await harness.runtime.deliverReplyOutbox(delivery.outbox[0]!.payload.payload, harness.gateway);
    expect(runtimeConversation(harness.runtime, "private:171419991")?.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "[图片]",
      imageUrls: ["https://example.test/selfie.png"],
      messageOrigin: "async_tool_callback",
      toolNames: ["selfie"]
    });
  });

  it("returns the persisted asynchronous image failure instead of a generic missing-image message", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const incoming = parseOneBotInboundMessage(privateEvent(30_002, "生成一张自拍"))!;
    harness.runtime.recordIncomingMessage(incoming);
    const rewriteToneText = vi.fn(async (text: string) => text);
    (harness.runtime as unknown as { rewriteToneText: typeof rewriteToneText }).rewriteToneText = rewriteToneText;
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const conversationId = conversationRecordId(incoming);
    const payload = {
      type: "tool_result",
      toolJobId: "job-selfie-failed",
      providerCallId: "call-selfie-failed",
      toolName: "selfie",
      originalRequest: {
        incoming,
        replyGate: harness.runtime.replyGates.capture(incoming.scope, conversationId),
        replyQuote: { enabled: false, replyToMessageId: null }
      },
      arguments: { scene: "图书馆" },
      outcome: {
        status: "failed",
        result: null,
        error: { name: "TypeError", message: "terminated" }
      }
    } satisfies AsyncToolCompletionPayload;

    await harness.runtime.replyToToolCompletion(
      payload,
      harness.gateway,
      new AbortController().signal,
      delivery
    );

    expect(rewriteToneText).toHaveBeenCalledWith(
      "图片生成失败：上游生图连接中断，请稍后重试",
      expect.objectContaining({ incoming })
    );
    expect(delivery.outbox).toHaveLength(1);
    expect(delivery.outbox[0]?.payload.payload).toMatchObject({
      text: "图片生成失败：上游生图连接中断，请稍后重试",
      generatedImages: [],
      messageOrigin: "async_tool_callback",
      toolNames: ["selfie"]
    });
  });

  it("fails closed for a legacy group callback without frozen gate and quote snapshots", async () => {
    let callbackRequest: RenderedPromptRequest | undefined;
    const harness = createRuntimeHarness(async (request) => {
      callbackRequest = request;
      return { kind: "completed", text: "legacy callback reply" };
    });
    const incoming = parseOneBotInboundMessage(groupEvent(30_003, 304, "legacy callback"))!;
    harness.runtime.recordIncomingMessage(incoming);
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const payload = {
      type: "tool_result",
      toolJobId: "job-legacy-group",
      providerCallId: "call-legacy-group",
      toolName: "codex",
      originalRequest: { incoming, captureSequence: 1 },
      arguments: { task: "legacy" },
      outcome: {
        status: "succeeded",
        result: { content: "legacy result" },
        error: undefined
      }
    } satisfies AsyncToolCompletionPayload;

    await harness.runtime.replyToToolCompletion(
      payload,
      harness.gateway,
      new AbortController().signal,
      delivery
    );

    expect(callbackRequest).toBeUndefined();
    expect(delivery.outbox).toEqual([]);
    expect(delivery.terminalStatus).toBe("no_reply");
  });

  it("does not guess the source of legacy outbox replies", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const incoming = parseOneBotInboundMessage(privateEvent(30_002, "旧队列消息"))!;
    harness.runtime.recordIncomingMessage(incoming);

    await harness.runtime.deliverReplyOutbox({
      type: "assistant_reply",
      incoming,
      text: "旧回复",
      generatedImages: [],
      isAdmin: true
    }, harness.gateway);

    const message = runtimeConversation(harness.runtime, "private:171419991")?.messages.at(-1);
    expect(message).toMatchObject({ role: "assistant", text: "旧回复" });
    expect(message?.messageOrigin).toBeUndefined();
    expect(message?.toolNames).toBeUndefined();
  });

  it("records the transport message ID so later explicit replies can inherit its thread", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const incoming = parseOneBotInboundMessage(groupEvent(30_004, 305, "发送一条可引用回复"))!;
    harness.runtime.recordIncomingMessage(incoming);
    (harness.gateway.send as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accepted: true, messageId: "880088" });

    await harness.runtime.deliverReplyOutbox({
      type: "assistant_reply",
      incoming,
      text: "可以引用这条消息。",
      generatedImages: [],
      isAdmin: false
    }, harness.gateway);

    expect(runtimeConversation(harness.runtime, "group:305")?.messages.at(-1)).toMatchObject({
      id: "880088",
      role: "assistant",
      text: "可以引用这条消息。",
      replyMessageIds: [30_004]
    });
  });

  it("keeps the durable reply target stable when quote settings change before outbox delivery", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const incoming = parseOneBotInboundMessage(groupEvent(30_005, 306, "持久引用目标"))!;
    harness.runtime.recordIncomingMessage(incoming);
    const draft = harness.runtime.replyDeliveryDraft(
      incoming,
      "引用目标不能漂移。",
      false
    );
    expect(draft.payload.payload.replyToMessageId).toBe(30_005);
    (harness.runtime as unknown as {
      config: { bot: { quoteGroupReplies: boolean } };
    }).config.bot.quoteGroupReplies = false;
    (harness.gateway.send as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accepted: true, messageId: "880089" });

    await harness.runtime.deliverReplyOutbox(draft.payload.payload, harness.gateway);

    expect(harness.gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: 30_005
    }));
    expect(runtimeConversation(harness.runtime, "group:306")?.messages.at(-1)).toMatchObject({
      id: "880089",
      replyMessageIds: [30_005]
    });
  });

  it("keeps unavailable Codex and Bash capabilities out of Provider options", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.asyncCodex).toBe(false);
      expect(options.bash).toBeUndefined();
      return { kind: "completed", text: "capabilities closed" };
    });
    const harness = createRuntimeHarness(
      completeRequestTurn,
      undefined,
      undefined,
      async () => ({ codex: false, workspaceBash: false })
    );

    await handleOneBotEvent(harness.runtime, privateEvent(22_002, "capability check"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledOnce();
  });

  it("keeps Codex unavailable for an ordinary group member", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.asyncCodex).toBe(false);
      return { kind: "completed", text: "管理员工具未开放" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);

    await handleOneBotEvent(
      harness.runtime,
      groupEvent(22_006, 605, "ordinary codex request", 998_103),
      harness.gateway
    );
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledOnce();
  });

  it("omits send_file when the current transport has no durable asset bridge", async () => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.conversationAssets).toBeUndefined();
      return { kind: "completed", text: "asset capability closed" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    harness.gateway.sendConversationAsset = undefined;

    await handleOneBotEvent(harness.runtime, privateEvent(22_003, "asset capability check"), harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "private user",
      event: privateEvent(22_004, "ordinary private asset request", 998_101),
      sessionId: "private:998101"
    },
    {
      label: "group member",
      event: groupEvent(22_005, 604, "ordinary group asset request", 998_102),
      sessionId: "group:604"
    }
  ])("allows an ordinary $label to return a Docker workbench file", async ({
    event,
    sessionId
  }) => {
    const completeRequestTurn = vi.fn(async (
      _request: RenderedPromptRequest,
      options: ProviderCompleteOptions = {}
    ): Promise<ProviderTurnResult> => {
      expect(options.conversationAssets?.enabled).toBe(true);
      const executor = new RegistryProviderToolExecutor();
      const definitions = executor.resolveDefinitions(options, [{ type: "function", function: sendFileTool }]);
      expect(definitions.map((definition) => definition.name)).toContain("send_file");
      const [output] = await executor.execute([{
        type: "function_call",
        name: "send_file",
        call_id: "forged-ordinary-send-file",
        arguments: JSON.stringify({ path: "exports/report.txt", kind: "file", name: null })
      }], options, definitions);
      expect(JSON.parse(String(output?.output))).toMatchObject({
        ok: true,
        queued: true,
        kind: "file",
        name: "report.txt",
        byteLength: 6
      });
      return { kind: "completed", text: "文件已发送" };
    });
    const harness = createRuntimeHarness(completeRequestTurn);
    const workbench = path.join(harness.runtime.config.persona.agentWorkspace, "docker-workbench", "exports");
    fs.mkdirSync(workbench, { recursive: true });
    fs.writeFileSync(path.join(workbench, "report.txt"), "report");

    await handleOneBotEvent(harness.runtime, event, harness.gateway);
    await harness.coordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).toHaveBeenCalledOnce();
    expect(harness.gateway.sendConversationAsset).toHaveBeenCalledOnce();
    expect(harness.store.listOutbox(sessionId).some((outbox) => outbox.kind === "onebot.conversation_asset"))
      .toBe(true);
  });
});

interface RuntimeHarness {
  runtime: SunaRuntime;
  store: SessionStore;
  gateway: MessagingPort;
  coordinator: {
    waitForIdle(options?: { timeoutMs?: number }): Promise<void>;
  };
}

function createRuntimeHarness(
  completeRequestTurn: (
    request: RenderedPromptRequest,
    options?: ProviderCompleteOptions
  ) => Promise<ProviderTurnResult>,
  codexRunner: CodexRunner | undefined = undefined,
  configure?: (config: ReturnType<typeof createAdminTestConfig>) => void,
  resolveToolCapabilities: RuntimeToolCapabilityResolver = async () => ({
    codex: true,
    workspaceBash: true
  }),
  replyDebounceMs = 0,
  enableNewConversationReplies = true
): RuntimeHarness {
  const resolvedCodexRunner: CodexRunner = codexRunner ?? {
    async run(_input, context) {
      return {
        ok: true,
        status: "succeeded",
        jobId: context.jobId,
        kind: "analysis",
        content: "unused"
      };
    }
  };
  const store = new SessionStore({ databasePath: ":memory:" });
  stores.push(store);
  const runtimeRoot = path.join("/tmp", `sunabot-runtime-session-queue-${process.pid}-${++runtimeRootSequence}`);
  runtimeRoots.push(runtimeRoot);
  const config = createAdminTestConfig(runtimeRoot);
  configure?.(config);
  const runtime = new SunaRuntime(config, {
    attachmentService: {} as never,
    sessionStore: store,
    codexRunner: resolvedCodexRunner,
    resolveToolCapabilities,
    replyDebounceMs
  });
  runtimes.push(runtime);
  const provider = {
    completeRequestTurn: vi.fn(completeRequestTurn),
    generateImage: vi.fn()
  } as unknown as OpenAIProvider;
  const internals = runtime as unknown as {
    persona: {
      id: "plana";
      name: string;
      files: unknown[];
      memoryItems: unknown[];
      systemPrompt: string;
    };
    conversationRecords: Map<string, ConversationRecord>;
    ensureConversationRecord(incoming: ParsedIncomingMessage, at: string): ConversationRecord;
    getProvider(): OpenAIProvider;
    prepareIncomingMessage(): Promise<void>;
    patchIncomingMessage(): void;
    scheduleAttachmentCacheRefresh(): void;
    persistConversationRecords(): void;
    renderPromptRequest(
      id: string,
      variables: Record<string, unknown>
    ): Promise<RenderedPromptRequest>;
    sessionCoordinator: RuntimeHarness["coordinator"];
  };
  internals.persona = {
    id: "plana",
    name: "普拉娜",
    files: [],
    memoryItems: [],
    systemPrompt: "test system"
  };
  internals.conversationRecords.clear();
  if (enableNewConversationReplies) {
    const ensureConversationRecord = internals.ensureConversationRecord.bind(runtime);
    internals.ensureConversationRecord = (incoming, at) => {
      const isNewConversation = !internals.conversationRecords.has(conversationRecordId(incoming));
      const record = ensureConversationRecord(incoming, at);
      if (isNewConversation) record.replyEnabled = true;
      return record;
    };
  }
  internals.getProvider = () => provider;
  internals.prepareIncomingMessage = async () => undefined;
  internals.patchIncomingMessage = () => undefined;
  internals.scheduleAttachmentCacheRefresh = () => undefined;
  internals.persistConversationRecords = () => undefined;
  internals.renderPromptRequest = async (id, variables) => ({
    messages: [
      { role: "system", content: "test system" },
      ...((variables["messages_64"] ?? []) as RenderedPromptRequest["messages"]),
      { role: "user", content: String(variables["user.input"] ?? "") }
    ],
    response_format: { type: "text" }
  });

  return {
    runtime,
    store,
    gateway: fakeGateway(),
    coordinator: internals.sessionCoordinator
  };
}

function fakeGateway() {
  return {
    getStatus: vi.fn(() => ({ connected: true, connections: 1, selfIds: ["4004"] })),
    send: vi.fn(async () => ({ accepted: true as const })),
    sendConversationAsset: vi.fn(async () => ({ accepted: true as const })),
    resolveSender: vi.fn(async ({ userId, current }) => current ?? { id: String(userId) }),
    getMessage: vi.fn(async () => ({
      text: "",
      media: [],
      attachments: [],
      replyMessageIds: [],
      sender: { id: "2002" }
    })),
    poke: vi.fn(async () => ({ accepted: true as const }))
  } as unknown as MessagingPort;
}

function handleOneBotEvent(runtime: SunaRuntime, event: OneBotEvent, gateway: MessagingPort, accountId?: string) {
  const incoming = parseOneBotInboundMessage(event);
  if (!incoming) throw new Error("test event did not produce an inbound message");
  incoming.agentId = runtime.config.persona.defaultAgentId;
  incoming.accountId = accountId ?? "primary";
  return runtime.handleInboundMessage(incoming, gateway);
}

function groupEvent(messageId: number, groupId: number, marker: string, userId = 171419991): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    message_id: messageId,
    user_id: userId,
    group_id: groupId,
    self_id: 4004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: `user-${groupId}` },
    message: `Plana ${marker}`
  };
}

function botGroupEvent(messageId: number, groupId: number, marker: string): OneBotEvent {
  return {
    ...groupEvent(messageId, groupId, marker),
    sub_type: "bot_group",
    sender: { nickname: `bot-${groupId}`, role: "bot" }
  };
}

function privateEvent(messageId: number, marker: string, userId = 171419991): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    message_id: messageId,
    user_id: userId,
    self_id: 4004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: "private-user" },
    message: marker
  };
}

function runtimeConversation(runtime: SunaRuntime, id: string) {
  return (runtime as unknown as {
    conversationRecords: Map<string, ConversationRecord>;
  }).conversationRecords.get(id);
}

function runtimeSeenIncoming(runtime: SunaRuntime) {
  return (runtime as unknown as {
    seenIncomingEvents: Map<string, number>;
  }).seenIncomingEvents;
}

function lastUserText(request: RenderedPromptRequest) {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function findMarker(text: string, markers: string[]) {
  const marker = markers.find((value) => text.includes(value));
  if (!marker) throw new Error(`No test marker in provider input: ${text}`);
  return marker;
}

function sentMessages(gateway: MessagingPort) {
  const send = gateway.send as unknown as ReturnType<typeof vi.fn>;
  return send.mock.calls.map((call) => [Number(call[0].groupId ?? call[0].userId), String(call[0].text)] as const);
}

function sentTexts(gateway: MessagingPort) {
  return sentMessages(gateway).map(([, text]) => text);
}

function memoryEntry(input: Pick<MemoryEntry, "id" | "source" | "sourceTitle" | "text">
  & Partial<MemoryEntry>): MemoryEntry {
  return {
    fileName: `${input.source}.json`,
    editable: true,
    key: input.id,
    value: input.text,
    field: "fact",
    ...input
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime Session queue condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
