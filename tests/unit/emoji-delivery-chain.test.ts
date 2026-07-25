// @vitest-environment node
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import type { MessagingPort, OutboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import type { ReplyDelivery } from "../../src/runtime/runtimeContracts.js";
import type { SunaRuntime as SunaRuntimeType } from "../../src/runtime.js";
import type { AppConfig, ParsedIncomingMessage } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const appendRequestLogStrict = vi.hoisted(() => vi.fn(async () => undefined));
const recallMemory = vi.hoisted(() => vi.fn(async () => ({ ok: true, matches: [] })));
const readUserProfileForUser = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../adapters/observability/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/observability/requestLog.js")>()),
  appendRequestLog,
  appendRequestLogStrict
}));
vi.mock("../../services/memory/memoryService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/memory/memoryService.js")>()),
  recallMemory,
  readUserProfileForUser
}));

let temporaryDirectory = "";
let workspaceDirectory = "";
let imagePath = "";
let imageBytes: Buffer;
let emojiFileName = "";
let config: AppConfig;
let closeApplicationDataStores: typeof import("../../adapters/sqlite/applicationDataStore.js").closeApplicationDataStores;
let SessionStore: typeof import("../../services/sessions/sessionStore.js").SessionStore;
let SunaRuntime: typeof import("../../src/runtime.js").SunaRuntime;
let OneBotGateway: typeof import("../../adapters/onebot/onebotGateway.js").OneBotGateway;
let OutboundMediaDelivery: typeof import("../../services/delivery/outboundMedia.js").OutboundMediaDelivery;
let ReplyGateEpochs: typeof import("../../services/orchestration/groupReplyPolicy.js").ReplyGateEpochs;
let decodeAssistantReply: typeof import("../../packages/contracts/session/runtimeMessages.js").decodeAssistantReply;
let planEmojiMarkers: typeof import("../../services/emojis/emojiCatalog.js").planEmojiMarkers;
let runtimeReplyDeliveryDraft: typeof import("../../src/runtime/delivery.js").runtime_replyDeliveryDraft;
let runtimeDeliverReplyOutbox: typeof import("../../src/runtime/delivery.js").runtime_deliverReplyOutbox;
let runtimeSendAssistantReply: typeof import("../../src/runtime/delivery.js").runtime_sendAssistantReply;
let outboundForIncoming: typeof import("../../src/runtime/messagingAttachmentHelpers.js").outboundForIncoming;

beforeAll(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-delivery-chain-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  vi.stubEnv("SUNABOT_WORKSPACE", workspaceDirectory);
  vi.resetModules();

  ({ SessionStore } = await import("../../services/sessions/sessionStore.js"));
  ({ SunaRuntime } = await import("../../src/runtime.js"));
  ({ OneBotGateway } = await import("../../adapters/onebot/onebotGateway.js"));
  ({ OutboundMediaDelivery } = await import("../../services/delivery/outboundMedia.js"));
  ({ ReplyGateEpochs } = await import("../../services/orchestration/groupReplyPolicy.js"));
  ({ decodeAssistantReply } = await import("../../packages/contracts/session/runtimeMessages.js"));
  ({ planEmojiMarkers } = await import("../../services/emojis/emojiCatalog.js"));
  ({
    runtime_deliverReplyOutbox: runtimeDeliverReplyOutbox,
    runtime_replyDeliveryDraft: runtimeReplyDeliveryDraft,
    runtime_sendAssistantReply: runtimeSendAssistantReply
  } = await import("../../src/runtime/delivery.js"));
  ({ outboundForIncoming } = await import("../../src/runtime/messagingAttachmentHelpers.js"));
  const applicationData = await import("../../adapters/sqlite/applicationDataStore.js");
  closeApplicationDataStores = applicationData.closeApplicationDataStores;
  const { emojiMediaLocation } = await import("../../src/emojis/emojiAssets.js");
  const { createAdminTestConfig } = await import("./admin-fixtures.js");

  config = createAdminTestConfig(path.join(temporaryDirectory, "runtime"));
  config.bot.emojiSendSize = 1024;
  config.persona.defaultAgentId = "koharu";
  config.persona.name = "小春";
  config.persona.agentWorkspace = path.join(workspaceDirectory, "business", "agents", "koharu");
  config.persona.systemPromptWorkspace = path.join(workspaceDirectory, "business", "prompts");
  await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
  await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });

  imageBytes = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 246, g: 184, b: 202, alpha: 1 }
    }
  }).png().toBuffer();
  emojiFileName = `emoji-${createHash("sha256").update(imageBytes).digest("hex")}.png`;
  imagePath = emojiMediaLocation(config, emojiFileName).filePath;
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, imageBytes);
  applicationData.applicationDataStore(config).upsertEmoji({
    key: "开心",
    fileName: emojiFileName,
    source: "generated",
    sizeBytes: imageBytes.length,
    width: 1024,
    height: 1024,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  });
});

afterAll(async () => {
  closeApplicationDataStores?.();
  vi.unstubAllEnvs();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("emoji durable delivery chain", () => {
  it("records mixed text without emoji history and skips pure emoji conversation records", async () => {
    const incoming = privateIncoming();
    const providerText = "收到[/开心]";
    const host = deliveryHost(vi.fn(async (value: string) => value), providerText);
    const recordAssistantMessage = vi.fn(() => ({ id: "private:42" }));
    Object.assign(host, { recordAssistantMessage });

    await runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn(async () => ({ accepted: true as const, messageId: "sent-emoji" })) } as unknown as MessagingPort,
      providerText,
      false,
      [],
      undefined,
      () => true,
      undefined,
      false,
      { messageOrigin: "text" },
      "buffered",
      undefined,
      emojiPlanFor(providerText)
    );

    expect(recordAssistantMessage).toHaveBeenCalledWith(
      incoming,
      "收到",
      [],
      undefined,
      undefined,
      { messageOrigin: "text" },
      expect.objectContaining({ messageId: "sent-emoji" })
    );

    const pureEmojiText = "[/开心]";
    recordAssistantMessage.mockClear();
    const pureEmojiHost = deliveryHost(vi.fn(async (value: string) => value), pureEmojiText);
    Object.assign(pureEmojiHost, { recordAssistantMessage });
    await runtimeSendAssistantReply.call(
      pureEmojiHost as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn(async () => ({ accepted: true as const, messageId: "direct-pure-emoji" })) } as unknown as MessagingPort,
      pureEmojiText,
      false,
      [],
      undefined,
      () => true,
      undefined,
      false,
      { messageOrigin: "text" },
      "buffered",
      undefined,
      emojiPlanFor(pureEmojiText)
    );
    expect(recordAssistantMessage).not.toHaveBeenCalled();

    const scheduleMemoryCompression = vi.fn();
    const enqueueConversationMemory = vi.fn(async () => undefined);
    Object.assign(host, {
      conversationRecords: new Map(),
      enqueueConversationMemory,
      scheduleMemoryCompression,
      scheduleMemoryDrain: vi.fn(),
      hooks: {
        run: vi.fn(async () => ({ text: providerText })),
        runEach: vi.fn(async () => undefined)
      }
    });
    const durableDraft = runtimeReplyDeliveryDraft.call(
      host as unknown as SunaRuntimeType,
      incoming,
      "",
      false,
      [{
        url: `/generated-images/workbench/koharu/emoji/${emojiFileName}`,
        filePath: imagePath
      }],
      undefined,
      undefined,
      false,
      { messageOrigin: "text" },
      undefined,
      [{ type: "sticker", imageIndex: 0 }]
    );
    await runtimeDeliverReplyOutbox.call(
      host as unknown as SunaRuntimeType,
      durableDraft.payload.payload,
      undefined,
      {
        signal: new AbortController().signal,
        phase: "settle",
        remoteReceipt: { accepted: true, messageId: "durable-emoji" },
        async sendRemote(operation) {
          return operation();
        },
        async settleStep(_step, operation) {
          return operation(`pure-emoji:${_step}`);
        },
        async settleEffectStep(_step, operation) {
          return operation(`pure-emoji:${_step}`);
        }
      }
    );
    expect(recordAssistantMessage).not.toHaveBeenCalled();
    expect(scheduleMemoryCompression).not.toHaveBeenCalled();
    expect(enqueueConversationMemory).not.toHaveBeenCalled();
  });

  it("creates a second durable message for emojis when separate sending is enabled", async () => {
    const incoming = privateIncoming();
    const providerText = "收到[/开心]";
    const host = deliveryHost(vi.fn(async (value: string) => value), providerText);
    host.config = structuredClone(config);
    host.config.bot.emojiSendSeparately = true;
    const delivery = { outbox: [] } satisfies ReplyDelivery;

    await runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn() } as unknown as MessagingPort,
      providerText,
      false,
      [],
      "emoji-separate-message",
      () => true,
      delivery,
      true,
      { messageOrigin: "text" },
      "buffered",
      undefined,
      emojiPlanFor(providerText)
    );

    expect(delivery.outbox).toHaveLength(2);
    expect(delivery.outbox.map((draft) => draft.kind === "onebot.reply" && draft.payload.payload)).toEqual([
      expect.objectContaining({ text: "收到", generatedImages: [], quoteReply: true }),
      expect.objectContaining({
        text: "",
        quoteReply: false,
        replyToMessageId: null,
        generatedImages: [expect.objectContaining({ filePath: imagePath })],
        contentSegments: [{ type: "sticker", imageIndex: 0 }]
      })
    ]);
  });

  it.each([
    "<exp>[/开心]</exp>",
    '<exp key="[/开心]"/>'
  ])("marks both segmented expression forms as stickers: %s", async (expressionXml) => {
    const incoming = privateIncoming();
    const providerText = "[/开心]";
    const host = deliveryHost(vi.fn(async (value: string) => value), providerText);
    host.config = structuredClone(config);
    host.config.bot.tone.enabled = true;
    host.config.bot.tone.segmentedReply = true;
    Object.assign(host, {
      rewriteToneDelivery: vi.fn(async () => ({
        segmented: true as const,
        content: expressionXml
      }))
    });
    const delivery = { outbox: [] } satisfies ReplyDelivery;

    await runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn() } as unknown as MessagingPort,
      providerText,
      false,
      [],
      "emoji-segmented-message",
      () => true,
      delivery,
      false,
      { messageOrigin: "text" },
      "buffered",
      undefined,
      emojiPlanFor(providerText)
    );

    expect(delivery.outbox).toHaveLength(1);
    const draft = delivery.outbox[0];
    if (draft?.kind !== "onebot.reply") throw new Error("expected onebot reply draft");
    expect(draft.payload.payload).toMatchObject({
      text: "",
      generatedImages: [{ filePath: imagePath }],
      contentSegments: [{ type: "sticker", imageIndex: 0 }]
    });
  });

  it("rejects the fifth known marker before hooks, tone, asset reads, outbox, or OneBot", async () => {
    const incoming = privateIncoming();
    const providerText = `正文${"[/开心]".repeat(5)}`;
    const rewriteToneText = vi.fn(async () => providerText);
    const host = deliveryHost(rewriteToneText, providerText);
    const gatewaySend = vi.fn(async () => ({ accepted: true as const }));
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const open = vi.spyOn(fs, "open");

    try {
      await expect(runtimeSendAssistantReply.call(
        host as unknown as SunaRuntimeType,
        "private:42",
        incoming,
        { send: gatewaySend } as unknown as MessagingPort,
        providerText,
        false,
        [],
        "emoji-marker-cap",
        () => true,
        delivery,
        false,
        { messageOrigin: "assistant_text", toolNames: ["assistant_text"] },
        "buffered",
        undefined,
        undefined
      )).rejects.toThrow("单条回复最多 4 个表情");

      expect(host.hooks.run).not.toHaveBeenCalled();
      expect(rewriteToneText).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(delivery.outbox).toHaveLength(0);
      expect(gatewaySend).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it("preserves ordered emoji segments through mixed-text tone rewrite, durable outbox restart, strict decode, and OneBot base64 delivery", async () => {
    const incoming = privateIncoming();
    const providerText = "正在处理[/开心]很快回来";
    const emojiPlan = planEmojiMarkers(providerText, {
      listAvailable: () => [{
        key: "开心",
        image: {
          url: `/generated-images/workbench/koharu/emoji/${emojiFileName}`,
          filePath: imagePath
        }
      }]
    });
    const hooks = { run: vi.fn(async () => ({ text: providerText })) };
    const rewriteToneText = vi.fn(async (value: string) => value
      .replace("正在处理", "正在认真处理")
      .replace("很快回来", "马上回来"));
    const deliveryConfig: AppConfig = {
      ...config,
      bot: { ...config.bot, emojiSendSize: 256 }
    };
    const host = {
      config: deliveryConfig,
      isReplySenderAllowed: () => true,
      hooks,
      rewriteToneText,
      replyGates: new ReplyGateEpochs(),
      groupReplyOptions: () => ({ replyToMessageId: undefined }),
      replyDeliveryDraft(...args: Parameters<typeof runtimeReplyDeliveryDraft>) {
        return runtimeReplyDeliveryDraft.call(host as unknown as SunaRuntimeType, ...args);
      }
    };
    const delivery = { outbox: [] } satisfies ReplyDelivery;

    await runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn() } as unknown as MessagingPort,
      providerText,
      false,
      [],
      "emoji-chain-run",
      () => true,
      delivery,
      false,
      { messageOrigin: "assistant_text", toolNames: ["assistant_text"] },
      "buffered",
      undefined,
      emojiPlan
    );

    expect(hooks.run).toHaveBeenCalledWith("before_reply", expect.objectContaining({ text: providerText }));
    expect(rewriteToneText).toHaveBeenCalledTimes(1);
    expect(rewriteToneText).toHaveBeenCalledWith(expect.stringContaining(providerText.slice(0, 4)), expect.objectContaining({
      incoming,
      logContext: expect.objectContaining({ runId: "emoji-chain-run" })
    }));
    expect(rewriteToneText.mock.calls[0]?.[0]).toContain("[/开心]");
    expect(delivery.outbox).toHaveLength(1);
    const draft = delivery.outbox[0];
    if (draft?.kind !== "onebot.reply") throw new Error("expected onebot reply draft");
    expect(draft.payload.payload).toMatchObject({
      text: "正在认真处理马上回来",
      contentSegments: [
        { type: "text", text: "正在认真处理" },
        { type: "sticker", imageIndex: 0 },
        { type: "text", text: "马上回来" }
      ],
      generatedImages: [{ filePath: expect.stringMatching(/emoji-[a-f0-9]{64}\.png$/u) }]
    });
    const resizedPath = draft.payload.payload.generatedImages[0]?.filePath;
    expect(resizedPath).toBeTruthy();
    expect(resizedPath).not.toBe(imagePath);
    const resizedBytes = await fs.readFile(resizedPath!);
    await expect(sharp(resizedBytes).metadata()).resolves.toMatchObject({ width: 256, height: 256, format: "png" });

    const databasePath = path.join(temporaryDirectory, "session-queue.sqlite");
    const before = new SessionStore({ databasePath });
    before.enqueueEvent({ sessionId: "private:42", kind: "incoming_reply", payload: {} });
    const claimed = before.claimNextTurn({ workerId: "emoji-chain-turn" });
    if (!claimed) throw new Error("expected claimed turn");
    before.finishTurn({
      turnId: claimed.turn.id,
      workerId: "emoji-chain-turn",
      outcome: "replied",
      outbox: [{
        kind: draft.kind,
        payload: draft.payload,
        deliveryPartition: "koharu-qq"
      }]
    });
    before.close();

    const after = new SessionStore({ databasePath, recoverOnOpen: "all" });
    const restored = after.listOutbox("private:42")[0];
    if (!restored) throw new Error("expected restored outbox");
    const decoded = decodeAssistantReply(restored.payload);
    expect(decoded.contentSegments).toEqual(draft.payload.payload.contentSegments);
    expect(() => decodeAssistantReply({
      ...restored.payload as Record<string, unknown>,
      payload: {
        ...decoded,
        contentSegments: [
          { type: "text", text: "正在认真处理" },
          { type: "sticker", imageIndex: 1 },
          { type: "text", text: "马上回来" }
        ]
      }
    })).toThrow("contentSegments");

    const server = http.createServer();
    const gateway = new OneBotGateway(
      server,
      deliveryConfig,
      { handleInboundMessage: vi.fn(async () => undefined) },
      {
        outboundMedia: new OutboundMediaDelivery({
          rootDir: path.join(workspaceDirectory, "business", "media", "images"),
          workspaceRoot: workspaceDirectory
        })
      }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const outbound = outboundForIncoming(
      decoded.incoming as ParsedIncomingMessage,
      decoded.text,
      decoded.generatedImages,
      undefined,
      decoded.contentSegments
    );
    await gateway.send(outbound);

    const message = sendAction.mock.calls[0]?.[1].message as Array<{
      type: string;
      data: Record<string, string>;
    }>;
    expect(message.map((segment) => segment.type)).toEqual(["text", "image", "text"]);
    expect(message[0]?.data.text).toBe("正在认真处理");
    expect(message[1]?.data.file).toBe(`base64://${resizedBytes.toString("base64")}`);
    expect(message[1]?.data.sub_type).toBe(1);
    expect(message[2]?.data.text).toBe("马上回来");
    after.close();
  });

  it("skips tone rewrite only when the reply contains emoji markers and no text", async () => {
    const incoming = privateIncoming();
    const providerText = "[/开心]";
    const emojiPlan = emojiPlanFor(providerText);
    const rewriteToneText = vi.fn(async () => {
      throw new Error("pure marker reply must not invoke tone rewrite");
    });
    const host = deliveryHost(rewriteToneText, providerText);
    host.config = structuredClone(config);
    host.config.bot.emojiSendSeparately = true;
    const delivery = { outbox: [] } satisfies ReplyDelivery;

    await runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn() } as unknown as MessagingPort,
      providerText,
      false,
      [],
      "emoji-marker-only",
      () => true,
      delivery,
      false,
      { messageOrigin: "assistant_text", toolNames: ["assistant_text"] },
      "buffered",
      undefined,
      emojiPlan
    );

    expect(rewriteToneText).not.toHaveBeenCalled();
    expect(delivery.outbox).toHaveLength(1);
    const draft = delivery.outbox[0];
    if (draft?.kind !== "onebot.reply") throw new Error("expected onebot reply draft");
    expect(draft.payload.payload).toMatchObject({
      text: "",
      generatedImages: [{ filePath: imagePath }],
      contentSegments: [{ type: "sticker", imageIndex: 0 }]
    });
  });

  it.each([
    ["adds a marker", "甲乙[/开心]丙丁[/开心]"],
    ["deletes a marker", "甲乙丙丁"],
    ["rewrites a marker", "甲乙[/哭]丙丁"],
    ["moves a marker within non-empty text", "甲[/开心]乙丙丁"]
  ])("fails closed when tone %s", async (_case, tonedText) => {
    const incoming = privateIncoming();
    const providerText = "甲乙[/开心]丙丁";
    const emojiPlan = emojiPlanFor(providerText);
    const rewriteToneText = vi.fn(async () => tonedText);
    const host = deliveryHost(rewriteToneText, providerText);
    const delivery = { outbox: [] } satisfies ReplyDelivery;

    await expect(runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn() } as unknown as MessagingPort,
      providerText,
      false,
      [],
      "emoji-tone-contract",
      () => true,
      delivery,
      false,
      { messageOrigin: "assistant_text", toolNames: ["assistant_text"] },
      "buffered",
      undefined,
      emojiPlan
    )).rejects.toThrow("语气改写改变了表情标记，请重试。");

    expect(rewriteToneText).toHaveBeenCalledTimes(1);
    expect(delivery.outbox).toHaveLength(0);
  });

  it("fails closed when tone adds a marker inside an intact guarded text segment", async () => {
    const incoming = privateIncoming();
    const providerText = "甲乙[/开心]丙丁";
    const emojiPlan = emojiPlanFor(providerText);
    const rewriteToneText = vi.fn(async (guardedText: string) =>
      guardedText.replace("甲乙", "甲乙[/开心]")
    );
    const host = deliveryHost(rewriteToneText, providerText);
    const delivery = { outbox: [] } satisfies ReplyDelivery;

    await expect(runtimeSendAssistantReply.call(
      host as unknown as SunaRuntimeType,
      "private:42",
      incoming,
      { send: vi.fn() } as unknown as MessagingPort,
      providerText,
      false,
      [],
      "emoji-tone-guard-bypass",
      () => true,
      delivery,
      false,
      { messageOrigin: "assistant_text", toolNames: ["assistant_text"] },
      "buffered",
      undefined,
      emojiPlan
    )).rejects.toThrow("语气改写改变了表情标记，请重试。");

    expect(rewriteToneText).toHaveBeenCalledTimes(1);
    expect(delivery.outbox).toHaveLength(0);
  });

  it("rejects a selected emoji whose bytes change after planning before any durable outbox write", async () => {
    const incoming = privateIncoming();
    const providerText = "前[/开心]后";
    const emojiPlan = emojiPlanFor(providerText);
    const rewriteToneText = vi.fn(async (value: string) => value);
    const host = deliveryHost(rewriteToneText, providerText);
    const delivery = { outbox: [] } satisfies ReplyDelivery;
    const corrupted = Buffer.from(imageBytes);
    corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 0xff;
    expect(corrupted).toHaveLength(imageBytes.length);
    await fs.writeFile(imagePath, corrupted);

    try {
      await expect(runtimeSendAssistantReply.call(
        host as unknown as SunaRuntimeType,
        "private:42",
        incoming,
        { send: vi.fn() } as unknown as MessagingPort,
        providerText,
        false,
        [],
        "emoji-integrity-contract",
        () => true,
        delivery,
        false,
        { messageOrigin: "assistant_text", toolNames: ["assistant_text"] },
        "buffered",
        undefined,
        emojiPlan
      )).rejects.toThrow("表情图片已损坏或不可用");
      expect(rewriteToneText).toHaveBeenCalledTimes(1);
      expect(delivery.outbox).toHaveLength(0);
    } finally {
      await fs.writeFile(imagePath, imageBytes);
    }
  });

  it("prepares deferred dispatch acknowledgement markers through the same durable reply draft contract", async () => {
    const store = new SessionStore({ databasePath: ":memory:" });
    const provider = {
      completeRequestTurn: vi.fn(async () => ({
        kind: "deferred" as const,
        acknowledgement: "我收到了[/开心]马上处理",
        toolCall: {
          name: "codex",
          callId: "emoji-deferred-call",
          arguments: { task: "inspect" }
        }
      })),
      generateImage: vi.fn()
    } as unknown as OpenAIProvider;
    const runtime = new SunaRuntime(config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
    });
    runtime.persona = {
      id: "koharu",
      name: "小春",
      files: [],
      memoryItems: [],
      systemPrompt: "test system"
    };
    runtime.getProvider = () => provider;
    runtime.prepareIncomingMessage = async () => undefined;
    runtime.scheduleAttachmentCacheRefresh = () => undefined;
    runtime.scheduleMemoryCompression = () => undefined;
    runtime.enqueueConversationMemory = async () => undefined;
    runtime.scheduleMemoryDrain = () => undefined;
    runtime.persistConversationRecords = () => undefined;
    runtime.prepareGroupThreadContext = async () => undefined;
    runtime.renderPromptRequest = async (_id, variables) => ({
      messages: [
        { role: "system", content: "test system" },
        ...((variables["messages_64"] ?? []) as Array<{ role: "user" | "assistant"; content: string }>),
        { role: "user", content: String(variables["user.input"] ?? "") }
      ],
      response_format: { type: "text" }
    });
    runtime.rewriteToneText = vi.fn(async (text: string) => text);
    const incoming = privateIncoming();
    runtime.recordIncomingMessage(incoming, { persist: false });
    let deferred: Parameters<NonNullable<Parameters<SunaRuntimeType["replyToIncoming"]>[3]["onDeferred"]>>[0]
      | undefined;

    await runtime.replyToIncoming("private:42", incoming, fakeGateway(), {
      captureSequence: 1,
      contextThroughSequence: 1,
      delivery: { outbox: [] },
      onDeferred: (value) => { deferred = value; }
    });

    const acknowledgement = decodeAssistantReply(deferred!.acknowledgement.payload);
    expect(acknowledgement).toMatchObject({
      text: "我收到了马上处理",
      messageOrigin: "async_tool_dispatch",
      toolNames: ["codex"],
      contentSegments: [
        { type: "text", text: "我收到了" },
        { type: "sticker", imageIndex: 0 },
        { type: "text", text: "马上处理" }
      ],
      generatedImages: [{ filePath: imagePath }]
    });
    expect(deferred?.acknowledgement.dedupeKey).toBe("tool-ack:codex:emoji-deferred-call");
    expect(deferred?.deferred.toolCall.arguments).not.toHaveProperty("dispatch_message");
    runtime.close();
    store.close();
  });
});

function emojiPlanFor(text: string) {
  return planEmojiMarkers(text, {
    listAvailable: () => ["开心", "哭"].map((key) => ({
      key,
      image: {
        url: `/generated-images/workbench/koharu/emoji/${emojiFileName}`,
        filePath: imagePath
      }
    }))
  });
}

function deliveryHost(rewriteToneText: ReturnType<typeof vi.fn>, beforeReplyText: string) {
  const host = {
    config,
    isReplySenderAllowed: () => true,
    hooks: { run: vi.fn(async () => ({ text: beforeReplyText })) },
    rewriteToneText,
    replyGates: new ReplyGateEpochs(),
    groupReplyOptions: () => ({ replyToMessageId: undefined }),
    replyDeliveryDraft(...args: Parameters<typeof runtimeReplyDeliveryDraft>) {
      return runtimeReplyDeliveryDraft.call(host as unknown as SunaRuntimeType, ...args);
    }
  };
  return host;
}

function privateIncoming(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    transport: "onebot",
    agentId: "koharu",
    accountId: "koharu-qq",
    scope: "private",
    messageId: 9001,
    time: "2026-07-18T00:00:00.000Z",
    userId: 42,
    selfId: 84,
    sender: { id: "42", displayName: "猫老师" },
    text: "请开始处理",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function fakeGateway() {
  return {
    getStatus: vi.fn(() => ({ connected: true, connections: 1, selfIds: ["84"] })),
    send: vi.fn(async (_message: OutboundMessageV1) => ({ accepted: true as const })),
    resolveSender: vi.fn(async ({ userId }: { userId: number }) => ({ id: String(userId) })),
    getMessage: vi.fn(async () => ({
      text: "",
      media: [],
      attachments: [],
      replyMessageIds: [],
      sender: { id: "42" }
    })),
    poke: vi.fn(async () => ({ accepted: true as const }))
  } as unknown as MessagingPort;
}
