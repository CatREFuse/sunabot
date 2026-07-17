// @vitest-environment node
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import * as agentServices from "../../services/agents/public.js";
import type {
  MessagingPort,
  MessagingStatusV1
} from "../../packages/contracts/messaging/messages.js";
import {
  incomingReplyEnvelope
} from "../../packages/contracts/session/runtimeMessages.js";
import type { OutboxDeliveryContext } from "../../services/sessions/sessionCoordinator.js";
import { OutboxDisconnectedError } from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord } from "../../services/sessions/sessionStore.js";
import { sendFileTool } from "../../services/tools/sendConversationAssetTool.js";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { SunaRuntime } from "../../src/runtime.js";
import type {
  ConversationAssetDeliveryDraft,
  ReplyDelivery
} from "../../src/runtime/runtimeContracts.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const appendRequestLogStrict = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/requestLog.js")>()),
  appendRequestLog,
  appendRequestLogStrict
}));

const runtimes: SunaRuntime[] = [];
const stores: SessionStore[] = [];
const roots: string[] = [];
const persistedOutboxes = new WeakMap<ConversationAssetDeliveryDraft, OutboxRecord>();
const persistedDraftIncoming = new WeakMap<ConversationAssetDeliveryDraft, ParsedIncomingMessage>();
let persistedOutboxSequence = 0;

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
  closeApplicationDataStores();
  appendRequestLog.mockClear();
  appendRequestLogStrict.mockClear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("RuntimeConversationAssets", () => {
  it("persists only a frozen current target and relative file fingerprint", async () => {
    const harness = createHarness(groupIncoming());
    const sensitiveInline = "data:image/png;base64,cHJpdmF0ZS1pbmxpbmUtYnl0ZXM=";
    const sensitiveRemoteUrl = "https://private.example.invalid/secret-image.png?token=raw-secret";
    const sensitiveSharedPath = path.join(harness.root, "private-shared-image.png");
    const sensitiveChunkPath = path.join(harness.root, "private-chunks.sqlite");
    const sensitiveVisualPath = path.join(harness.root, "private-page-1.png");
    const sensitiveVisualSource = path.join(harness.root, "private-source.pdf");
    harness.incoming.text = "private-message-body-should-not-persist";
    harness.incoming.sender = {
      id: String(harness.incoming.userId),
      nickname: "private-sender-nickname",
      displayName: "private-sender-display"
    };
    harness.incoming.media = [{
      schemaVersion: 1,
      kind: "image",
      source: "inline_data",
      url: sensitiveInline
    }, {
      schemaVersion: 1,
      kind: "image",
      source: "shared_file",
      filePath: sensitiveSharedPath,
      url: sensitiveRemoteUrl
    }];
    harness.incoming.attachments = [{
      id: "private-attachment-id",
      source: "message",
      name: "private-attachment-name.pdf",
      status: "ready",
      url: "https://private.example.invalid/attachment?raw=1",
      chunkIndexPath: sensitiveChunkPath,
      visualPagePaths: [sensitiveVisualPath],
      visualSourcePath: sensitiveVisualSource
    }];
    harness.incoming.quoteReferences = [{
      messageId: 18_001,
      text: "private-quote-body",
      imageUrls: ["https://private.example.invalid/quote.png"],
      attachments: [{
        id: "private-quote-attachment",
        source: "quote",
        name: "private-quote.pdf",
        status: "ready",
        chunkIndexPath: path.join(harness.root, "private-quote-chunks.sqlite")
      }]
    }];
    writeWorkbenchFile(harness, "exports/report.txt", "report");

    const draft = await queueAsset(harness, {
      path: "exports/report.txt",
      kind: "file"
    });
    harness.incoming.accountId = "changed-account";
    harness.incoming.groupId = 999;
    harness.incoming.userId = 888;

    expect(draft.deliveryPartition).toBe("account-b");
    expect(draft.payload.payload).toMatchObject({
      type: "conversation_asset",
      target: {
        transport: "onebot",
        agentId: "plana",
        accountId: "account-b",
        scope: "user_group",
        userId: 171419991,
        groupId: 602,
        messageId: 19_980,
        selfId: 4004,
        conversationId: "account:account-b:group:602"
      },
      incomingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolName: "send_file",
      asset: {
        path: "exports/report.txt",
        kind: "file",
        name: "report.txt",
        byteLength: 6,
        sha256: "845e91831319e89c4d656bdb80c278ac09a7230d61e5dfd2e1b1fbb436ac8917",
        rootIdentity: {
          dev: expect.stringMatching(/^\d+$/),
          ino: expect.stringMatching(/^\d+$/),
          ctimeNs: expect.stringMatching(/^\d+$/)
        }
      },
      replyGate: {
        generation: expect.any(String),
        scope: "user_group",
        conversationId: "account:account-b:group:602",
        scopeEpoch: 0,
        conversationEpoch: 0
      }
    });
    const persisted = JSON.stringify(draft.payload);
    expect(Object.keys(draft.payload.payload).sort()).toEqual([
      "asset",
      "incomingFingerprint",
      "logRunId",
      "replyGate",
      "target",
      "toolName",
      "type"
    ]);
    expect(Object.keys(draft.payload.payload.target).sort()).toEqual([
      "accountId",
      "agentId",
      "conversationId",
      "groupId",
      "messageId",
      "scope",
      "selfId",
      "transport",
      "userId"
    ]);
    for (const secret of [
      "private-message-body-should-not-persist",
      "private-sender-nickname",
      "private-sender-display",
      sensitiveInline,
      sensitiveRemoteUrl,
      sensitiveSharedPath,
      sensitiveChunkPath,
      sensitiveVisualPath,
      sensitiveVisualSource,
      "private-attachment-name.pdf",
      "private-quote-body",
      "private-quote-chunks.sqlite",
      "https://private.example.invalid"
    ]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).not.toContain(harness.workbenchRoot);
  });

  it("freezes and targets the primary account explicitly", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });

    expect(draft.deliveryPartition).toBe("primary");
    expect(draft.payload.payload.target).toMatchObject({
      transport: "onebot",
      agentId: "plana",
      accountId: "primary",
      scope: "private",
      userId: 171419991
    });
    await expect(harness.runtime.deliverConversationAssetOutbox(
      outboxRecord(harness, draft),
      deliveryContext().context
    )).resolves.toMatchObject({ delivered: true });
    expect(harness.sendConversationAsset).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "primary",
      scope: "private",
      userId: 171419991
    }));
  });

  it("normalizes a missing queue source without exposing Agent workspace paths", async () => {
    const harness = createHarness(privateIncoming());
    const emitOutbox = vi.fn(async () => undefined);
    const delivery: ReplyDelivery = { outbox: [], emitOutbox };

    const error = await harness.runtime.queueConversationAsset({
      incoming: harness.incoming,
      gateway: harness.gateway,
      input: { path: "exports/missing.txt", kind: "file" },
      callId: "call-missing-file",
      logRunId: "run-missing-file",
      isCurrent: () => true,
      delivery
    }).catch((caught: unknown) => caught as Error & { code?: string });

    expect(error).toMatchObject({ code: "SEND_FILE_SOURCE_MISSING" });
    expectSanitized(error, harness.root, harness.config.persona.agentWorkspace, harness.workbenchRoot);
    expect(emitOutbox).not.toHaveBeenCalled();

    appendRequestLog.mockClear();
    const toolOutput = await executeSendFileTool(harness, "exports/missing.txt");
    expect(toolOutput).toMatchObject({ ok: false, error: expect.stringContaining("SEND_FILE_SOURCE_MISSING") });
    expectSanitized(toolOutput, harness.root, harness.config.persona.agentWorkspace, harness.workbenchRoot);
    expectSanitized(
      appendRequestLog.mock.calls,
      harness.root,
      harness.config.persona.agentWorkspace,
      harness.workbenchRoot
    );
  });

  it.runIf(process.platform !== "win32")(
    "normalizes a permission-denied queue source without exposing Agent workspace paths",
    async () => {
      const harness = createHarness(privateIncoming());
      const filePath = writeWorkbenchFile(harness, "exports/restricted.txt", "restricted");
      fs.chmodSync(filePath, 0o000);
      try {
        const error = await harness.runtime.queueConversationAsset({
          incoming: harness.incoming,
          gateway: harness.gateway,
          input: { path: "exports/restricted.txt", kind: "file" },
          callId: "call-restricted-file",
          logRunId: "run-restricted-file",
          isCurrent: () => true,
          delivery: { outbox: [], emitOutbox: vi.fn(async () => undefined) }
        }).catch((caught: unknown) => caught as Error & { code?: string });

        expect(error).toMatchObject({ code: "SEND_FILE_SOURCE_FORBIDDEN" });
        expectSanitized(error, harness.root, harness.config.persona.agentWorkspace, harness.workbenchRoot);

        appendRequestLog.mockClear();
        const toolOutput = await executeSendFileTool(harness, "exports/restricted.txt");
        expect(toolOutput).toMatchObject({
          ok: false,
          error: expect.stringContaining("SEND_FILE_SOURCE_FORBIDDEN")
        });
        expectSanitized(toolOutput, harness.root, harness.config.persona.agentWorkspace, harness.workbenchRoot);
        expectSanitized(
          appendRequestLog.mock.calls,
          harness.root,
          harness.config.persona.agentWorkspace,
          harness.workbenchRoot
        );
      } finally {
        fs.chmodSync(filePath, 0o600);
      }
    }
  );

  it.each([
    { label: "private user", incoming: incoming({ scope: "private", userId: 998_001 }) },
    { label: "group member", incoming: incoming({ scope: "user_group", groupId: 602, userId: 998_002 }) }
  ])("keeps send_file unavailable with zero file reads for an ordinary $label", async ({ incoming }) => {
    const harness = createHarness(incoming);
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    const emitOutbox = vi.fn(async () => undefined);
    const delivery: ReplyDelivery = { outbox: [], emitOutbox };
    try {
      expect(harness.runtime.conversationAssetProviderOptions(
        incoming,
        harness.gateway,
        "ordinary-user-run",
        () => true,
        delivery
      )).toBeUndefined();
      await expect(harness.runtime.queueConversationAsset({
        incoming,
        gateway: harness.gateway,
        input: { path: "exports/report.txt", kind: "file" },
        callId: "forged-ordinary-send-file",
        logRunId: "ordinary-user-run",
        isCurrent: () => true,
        delivery
      })).rejects.toThrow("send_file is unavailable for the current user");
      expect(resolveFile).not.toHaveBeenCalled();
      expect(emitOutbox).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
    }
  });

  it("keeps send_file unavailable for Web Chat and rejects a forged Web origin event", async () => {
    const webIncoming = { ...privateIncoming(), transport: "web" as const };
    const webHarness = createHarness(webIncoming);
    writeWorkbenchFile(webHarness, "exports/report.txt", "report");
    const emitOutbox = vi.fn(async () => undefined);
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      expect(webHarness.runtime.conversationAssetProviderOptions(
        webIncoming,
        webHarness.gateway,
        "web-run",
        () => true,
        { outbox: [], emitOutbox }
      )).toBeUndefined();
      await expect(webHarness.runtime.queueConversationAsset({
        incoming: webIncoming,
        gateway: webHarness.gateway,
        input: { path: "exports/report.txt", kind: "file" },
        callId: "forged-web-send-file",
        logRunId: "web-run",
        isCurrent: () => true,
        delivery: { outbox: [], emitOutbox }
      })).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveFile).not.toHaveBeenCalled();
      expect(emitOutbox).not.toHaveBeenCalled();

      const onebotHarness = createHarness(privateIncoming());
      writeWorkbenchFile(onebotHarness, "exports/report.txt", "report");
      const draft = await queueAsset(onebotHarness, { path: "exports/report.txt", kind: "file" });
      const { outbox } = persistAssetOutbox(
        onebotHarness.store,
        draft,
        "asset-forged-web-origin",
        webIncoming,
        draft.payload.conversationId
      );
      resolveFile.mockClear();
      try {
        await expect(onebotHarness.runtime.deliverConversationAssetOutbox(
          outbox,
          deliveryContext().context
        )).rejects.toMatchObject({ code: "contract_field_invalid" });
        expect(resolveFile).not.toHaveBeenCalled();
        expect(onebotHarness.sendConversationAsset).not.toHaveBeenCalled();
      } finally {}
    } finally {
      resolveFile.mockRestore();
    }
  });

  it("rejects a helper result that is no longer a safe relative path before outbox persistence", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const outsideDir = path.join(harness.root, "outside-helper-result");
    const outsideFile = path.join(outsideDir, "report.txt");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, "outside-secret");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile").mockResolvedValue(outsideFile);
    const emitOutbox = vi.fn(async () => undefined);
    try {
      const error = await harness.runtime.queueConversationAsset({
        incoming: harness.incoming,
        gateway: harness.gateway,
        input: { path: "exports/report.txt", kind: "file" },
        callId: "helper-result-race",
        logRunId: "helper-result-race",
        isCurrent: () => true,
        delivery: { outbox: [], emitOutbox }
      }).catch((caught: unknown) => caught as Error & { code?: string });

      expect(error).toMatchObject({ code: "SEND_FILE_SOURCE_UNSAFE" });
      expectSanitized(error, harness.root, harness.workbenchRoot, outsideDir, outsideFile);
      expect(emitOutbox).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
    }
  });

  it("pauses while disconnected and resumes the frozen secondary account target", async () => {
    let status: MessagingStatusV1 = {
      connected: false,
      connections: 0,
      selfIds: [],
      accounts: []
    };
    const harness = createHarness(groupIncoming(), () => status);
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const delivery = deliveryContext();

    await expect(harness.runtime.deliverConversationAssetOutbox(
      outboxRecord(harness, draft),
      delivery.context
    )).rejects.toBeInstanceOf(OutboxDisconnectedError);
    expect(harness.sendConversationAsset).not.toHaveBeenCalled();

    status = {
      connected: true,
      connections: 1,
      selfIds: ["4004"],
      accounts: [{ accountId: "account-b", selfId: "4004", connectedAt: new Date().toISOString() }]
    };
    await expect(harness.runtime.deliverConversationAssetOutbox(
      outboxRecord(harness, draft),
      delivery.context
    )).resolves.toMatchObject({ delivered: true });
    expect(harness.sendConversationAsset).toHaveBeenCalledOnce();
    expect(harness.sendConversationAsset).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-b",
      scope: "user_group",
      userId: 171419991,
      groupId: 602
    }));
  });

  it("does not resend or reread after remote success when local settle fails", async () => {
    const harness = createHarness(privateIncoming());
    const filePath = writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    let failSettle = true;
    const delivery = deliveryContext({
      settleStep: async (_step, operation) => {
        await operation("outbox:asset:settle:request_log");
        if (failSettle) {
          failSettle = false;
          throw new Error("injected:settle-checkpoint");
        }
      }
    });
    const outbox = outboxRecord(harness, draft);

    await expect(harness.runtime.deliverConversationAssetOutbox(outbox, delivery.context))
      .rejects.toThrow("injected:settle-checkpoint");
    fs.rmSync(filePath);
    harness.runtime.config.bot.adminQq = "998104";
    await expect(harness.runtime.deliverConversationAssetOutbox(outbox, delivery.context))
      .resolves.toMatchObject({ delivered: true });

    expect(harness.sendConversationAsset).toHaveBeenCalledOnce();
    expect(delivery.context.phase).toBe("settle");
    expect(appendRequestLogStrict).toHaveBeenCalledTimes(2);
  });

  it("rejects asset delivery without a durable outbox context before any file read", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const resolveRoot = vi.spyOn(agentServices, "resolveAgentWorkbench");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        outboxRecord(harness, draft),
        new AbortController().signal
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveRoot).not.toHaveBeenCalled();
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveRoot.mockRestore();
      resolveFile.mockRestore();
    }
  });

  it("skips a queued asset when the reply gate closes", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    harness.runtime.cancelScopeReplies("private");

    await expect(harness.runtime.deliverConversationAssetOutbox(
      outboxRecord(harness, draft),
      deliveryContext().context
    )).resolves.toEqual({ delivered: false, skipped: "reply_gate_closed" });
    expect(harness.sendConversationAsset).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing gate",
      mutate(payload: Record<string, any>) { delete payload.replyGate; }
    },
    {
      label: "invalid generation",
      mutate(payload: Record<string, any>) { payload.replyGate.generation = " "; }
    },
    {
      label: "shape-valid foreign generation",
      mutate(payload: Record<string, any>) { payload.replyGate.generation = "foreign-generation"; }
    },
    {
      label: "invalid scope",
      mutate(payload: Record<string, any>) { payload.replyGate.scope = "invalid"; }
    },
    {
      label: "payload scope mismatch",
      mutate(payload: Record<string, any>) { payload.replyGate.scope = "user_group"; }
    },
    {
      label: "conversation mismatch",
      mutate(payload: Record<string, any>) { payload.replyGate.conversationId = "private:99999"; }
    },
    {
      label: "invalid scope epoch",
      mutate(payload: Record<string, any>) { payload.replyGate.scopeEpoch = -1; }
    },
    {
      label: "invalid conversation epoch",
      mutate(payload: Record<string, any>) { payload.replyGate.conversationEpoch = "0"; }
    },
    {
      label: "payload extra host path",
      mutate(payload: Record<string, any>) { payload.hostPath = "/private/asset-secret"; }
    },
    {
      label: "target extra",
      mutate(payload: Record<string, any>) { payload.target.hostPath = "/private/target-secret"; }
    },
    {
      label: "asset extra",
      mutate(payload: Record<string, any>) { payload.asset.source = "base64://c2VjcmV0"; }
    },
    {
      label: "root identity extra",
      mutate(payload: Record<string, any>) { payload.asset.rootIdentity.hostPath = "/private/root-secret"; }
    },
    {
      label: "reply gate extra",
      mutate(payload: Record<string, any>) { payload.replyGate.hostPath = "/private/gate-secret"; }
    }
  ])("rejects forged admin outbox with $label before any workbench read", async ({ mutate }) => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const forged = structuredClone(outboxRecord(harness, draft)) as OutboxRecord & {
      payload: { payload: Record<string, any> };
    };
    mutate(forged.payload.payload);
    const resolveRoot = vi.spyOn(agentServices, "resolveAgentWorkbench");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        forged,
        deliveryContext().context
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveRoot).not.toHaveBeenCalled();
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveRoot.mockRestore();
      resolveFile.mockRestore();
    }
  });

  it.each([
    {
      label: "session",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.sessionId = "private:99999"; }
    },
    {
      label: "partition",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.deliveryPartition = "account-c"; }
    },
    {
      label: "agent",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.payload.target.agentId = "other"; }
    },
    {
      label: "account target",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.payload.target.accountId = "account-c"; }
    },
    {
      label: "transport",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.payload.target.transport = "web"; }
    },
    {
      label: "conversation envelope",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.conversationId = "private:99999"; }
    },
    {
      label: "correlation",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.correlationId = "other-run"; }
    },
    {
      label: "idempotency",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.idempotencyKey = "forged"; }
    },
    {
      label: "dedupe fingerprint",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.dedupeKey = `${outbox.dedupeKey}:forged`; }
    },
    {
      label: "envelope extra",
      mutate(outbox: OutboxRecord & { payload: any }) { outbox.payload.hostPath = "/private/envelope-secret"; }
    }
  ])("rejects $label provenance mismatch before any workbench read", async ({ mutate }) => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const forged = structuredClone(outboxRecord(harness, draft)) as OutboxRecord & { payload: any };
    mutate(forged);
    const resolveRoot = vi.spyOn(agentServices, "resolveAgentWorkbench");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        forged,
        deliveryContext().context
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveRoot).not.toHaveBeenCalled();
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveRoot.mockRestore();
      resolveFile.mockRestore();
    }
  });

  it("rejects a canonical forged admin target that does not belong to its origin event", async () => {
    const harness = createHarness(groupIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const original = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const forged = structuredClone(original);
    const forgedConversationId = "account:account-c:group:999";
    forged.deliveryPartition = "account-c";
    forged.payload.conversationId = forgedConversationId;
    forged.payload.payload.target.accountId = "account-c";
    forged.payload.payload.target.groupId = 999;
    forged.payload.payload.target.conversationId = forgedConversationId;
    forged.payload.payload.replyGate.conversationId = forgedConversationId;
    forged.payload.idempotencyKey = assetIdempotencyKey(forged);
    forged.dedupeFingerprint = assetDraftFingerprint(forged);
    const { outbox } = persistAssetOutbox(
      harness.store,
      forged,
      "asset-forged-target",
      persistedDraftIncoming.get(original),
      original.payload.conversationId
    );
    const resolveRoot = vi.spyOn(agentServices, "resolveAgentWorkbench");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        outbox,
        deliveryContext().context
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveRoot).not.toHaveBeenCalled();
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveRoot.mockRestore();
      resolveFile.mockRestore();
    }
  });

  it("fails closed for internal voice queue calls and forged voice outbox", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/voice.amr", Buffer.from("#!AMR\nvoice"));
    const delivery: ReplyDelivery = { outbox: [], emitOutbox: vi.fn(async () => undefined) };

    await expect(harness.runtime.queueConversationAsset({
      incoming: harness.incoming,
      gateway: harness.gateway,
      input: { path: "exports/voice.amr", kind: "voice" },
      callId: "call-forged-voice",
      logRunId: "run-forged-voice",
      isCurrent: () => true,
      delivery
    })).rejects.toThrow("send_voice_message is disabled");
    expect(delivery.emitOutbox).not.toHaveBeenCalled();

    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    draft.payload.payload.toolName = "send_voice_message";
    draft.payload.payload.asset.kind = "voice";
    await expect(harness.runtime.deliverConversationAssetOutbox(
      outboxRecord(harness, draft),
      deliveryContext().context
    )).rejects.toThrow("send_voice_message is disabled");
    expect(harness.sendConversationAsset).not.toHaveBeenCalled();
  });

  it("fails closed before file reads for a forged ordinary-user asset outbox", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    draft.payload.payload.target.userId = 998_103;
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        outboxRecord(harness, draft),
        deliveryContext().context
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
    }
  });

  it.each([
    {
      label: "content changes",
      initialPath: "exports/report.txt",
      initialContent: "report",
      kind: "file" as const,
      mutate(filePath: string) { fs.writeFileSync(filePath, "changed"); },
      error: /changed after it was queued/
    },
    {
      label: "type changes",
      initialPath: "exports/pixel.png",
      initialContent: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      ),
      kind: "image" as const,
      mutate(filePath: string) { fs.writeFileSync(filePath, "not an image"); },
      error: /not a recognized image/
    },
    {
      label: "path becomes a symlink",
      initialPath: "exports/report.txt",
      initialContent: "report",
      kind: "file" as const,
      mutate(filePath: string) {
        const replacement = path.join(path.dirname(filePath), "replacement.txt");
        fs.writeFileSync(replacement, "report");
        fs.rmSync(filePath);
        fs.symlinkSync(replacement, filePath);
      },
      error: /symbolic links/
    }
  ])("rejects queued delivery when $label", async ({
    initialPath,
    initialContent,
    kind,
    mutate,
    error
  }) => {
    const harness = createHarness(privateIncoming());
    const filePath = writeWorkbenchFile(harness, initialPath, initialContent);
    const draft = await queueAsset(harness, { path: initialPath, kind });
    mutate(filePath);

    await expect(harness.runtime.deliverConversationAssetOutbox(
      outboxRecord(harness, draft),
      deliveryContext().context
    )).rejects.toThrow(error);
    expect(harness.sendConversationAsset).not.toHaveBeenCalled();
  });

  it("normalizes a workbench root symlink swap without exposing outside paths", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const originalRoot = `${harness.workbenchRoot}-original`;
    const outsideDir = path.join(harness.root, "outside-secret");
    fs.mkdirSync(path.join(outsideDir, "exports"), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "exports", "report.txt"), "outside-secret");
    fs.renameSync(harness.workbenchRoot, originalRoot);
    fs.symlinkSync(outsideDir, harness.workbenchRoot);
    try {
      const error = await harness.runtime.deliverConversationAssetOutbox(
        outboxRecord(harness, draft),
        deliveryContext().context
      ).catch((caught: unknown) => caught as Error);

      expect(error.message).toMatch(/AGENT_WORKBENCH_INVALID|SEND_FILE_ROOT_CHANGED/);
      expectSanitized(
        error,
        harness.root,
        harness.config.persona.agentWorkspace,
        harness.workbenchRoot,
        outsideDir
      );
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(harness.workbenchRoot);
      fs.renameSync(originalRoot, harness.workbenchRoot);
    }
  });

  it("rejects a regular workbench root replacement even with identical content", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const originalRoot = `${harness.workbenchRoot}-original`;
    fs.renameSync(harness.workbenchRoot, originalRoot);
    fs.mkdirSync(path.join(harness.workbenchRoot, "exports"), { recursive: true });
    fs.writeFileSync(path.join(harness.workbenchRoot, "exports", "report.txt"), "report");
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        outboxRecord(harness, draft),
        deliveryContext().context
      )).rejects.toMatchObject({ code: "SEND_FILE_ROOT_CHANGED" });
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
      fs.rmSync(harness.workbenchRoot, { recursive: true, force: true });
      fs.renameSync(originalRoot, harness.workbenchRoot);
    }
  });

  it("requires a fresh queue after the workbench root ctime changes", async () => {
    const harness = createHarness(privateIncoming());
    writeWorkbenchFile(harness, "exports/report.txt", "report");
    const draft = await queueAsset(harness, { path: "exports/report.txt", kind: "file" });
    const originalMode = fs.statSync(harness.workbenchRoot).mode & 0o777;
    fs.chmodSync(harness.workbenchRoot, originalMode ^ 0o020);
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      await expect(harness.runtime.deliverConversationAssetOutbox(
        outboxRecord(harness, draft),
        deliveryContext().context
      )).rejects.toMatchObject({ code: "SEND_FILE_ROOT_CHANGED" });
      expect(resolveFile).not.toHaveBeenCalled();
      expect(harness.sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
      fs.chmodSync(harness.workbenchRoot, originalMode);
    }
  });

  it("persists only a normalized outbox error when a queued source is deleted", async () => {
    const incoming = privateIncoming();
    const first = createHarness(incoming);
    const filePath = writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-failure-queue.sqlite");
    let storeNow = 4_000_000_000_000;
    const store = new SessionStore({ databasePath, clock: () => storeNow });
    stores.push(store);
    const { event } = persistAssetOutbox(store, draft, "asset-failure-before");
    fs.rmSync(filePath);

    const runtime = new SunaRuntime(first.config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
    });
    runtimes.push(runtime);
    runtime.activeGateway = fakeGateway(
      () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
      vi.fn(async () => ({ accepted: true as const, messageId: "must-not-send" }))
    );
    enableConversationReplies(runtime, incoming);
    await driveAssetOutboxToTerminal(runtime, store, event.sessionId, "primary", () => {
      storeNow += 60_000;
    });

    const failed = store.listOutbox(event.sessionId)[0]!;
    expect(failed.error).toMatchObject({
      code: "SEND_FILE_SOURCE_MISSING",
      message: expect.stringContaining("SEND_FILE_SOURCE_MISSING")
    });
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const row = inspection.prepare("SELECT result_json, error_json FROM outbox WHERE id = ?")
      .get(failed.id) as { result_json: string | null; error_json: string | null };
    inspection.close();
    const persistedError = JSON.stringify({ mapped: failed.error, row });
    expect(persistedError).toContain("SEND_FILE_SOURCE_MISSING");
    expectSanitized(
      persistedError,
      first.root,
      first.config.persona.agentWorkspace,
      first.workbenchRoot,
      filePath
    );
  });

  it("persists only a normalized outbox error after a workbench root symlink swap", async () => {
    const incoming = privateIncoming();
    const first = createHarness(incoming);
    writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-root-swap-queue.sqlite");
    let storeNow = 4_000_000_000_000;
    const store = new SessionStore({ databasePath, clock: () => storeNow });
    stores.push(store);
    const { event } = persistAssetOutbox(store, draft, "asset-root-swap-before");

    const originalRoot = `${first.workbenchRoot}-original`;
    const outsideDir = path.join(first.root, "outside-root-swap");
    fs.mkdirSync(path.join(outsideDir, "exports"), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "exports", "report.txt"), "outside-secret");
    fs.renameSync(first.workbenchRoot, originalRoot);
    fs.symlinkSync(outsideDir, first.workbenchRoot);
    try {
      const runtime = new SunaRuntime(first.config, {
        attachmentService: {} as never,
        sessionStore: store,
        resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
      });
      runtimes.push(runtime);
      runtime.activeGateway = fakeGateway(
        () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
        vi.fn(async () => ({ accepted: true as const, messageId: "must-not-send" }))
      );
      enableConversationReplies(runtime, incoming);
      await driveAssetOutboxToTerminal(runtime, store, event.sessionId, "primary", () => {
        storeNow += 60_000;
      });

      const failed = store.listOutbox(event.sessionId)[0]!;
      expect(failed.error).toMatchObject({ message: expect.stringContaining("AGENT_WORKBENCH_INVALID") });
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      const row = inspection.prepare("SELECT result_json, error_json FROM outbox WHERE id = ?")
        .get(failed.id) as { result_json: string | null; error_json: string | null };
      inspection.close();
      const persistedError = JSON.stringify({ mapped: failed.error, row });
      expect(persistedError).toContain("AGENT_WORKBENCH_INVALID");
      expectSanitized(
        persistedError,
        first.root,
        first.config.persona.agentWorkspace,
        first.workbenchRoot,
        originalRoot,
        outsideDir
      );
    } finally {
      fs.unlinkSync(first.workbenchRoot);
      fs.renameSync(originalRoot, first.workbenchRoot);
    }
  });

  it("normalizes an injected EIO path across tool output, request log, and persisted outbox error", async () => {
    const incoming = privateIncoming();
    const first = createHarness(incoming);
    writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-eio-queue.sqlite");
    let storeNow = 4_000_000_000_000;
    const store = new SessionStore({ databasePath, clock: () => storeNow });
    stores.push(store);
    const { event } = persistAssetOutbox(store, draft, "asset-eio-before");

    const hostPath = path.join(first.workbenchRoot, "exports", "io-secret.txt");
    const filesystemError = Object.assign(
      new Error(`EIO: input/output error, realpath '${hostPath}'`),
      { code: "EIO", path: hostPath, syscall: "realpath", errno: -5 }
    );
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile").mockRejectedValue(filesystemError);
    try {
      appendRequestLog.mockClear();
      const toolOutput = await executeSendFileTool(first, "exports/report.txt");
      expect(toolOutput).toMatchObject({
        ok: false,
        error: expect.stringContaining("SEND_FILE_SOURCE_UNAVAILABLE")
      });
      expectSanitized(toolOutput, first.root, first.config.persona.agentWorkspace, first.workbenchRoot, hostPath);
      expectSanitized(
        appendRequestLog.mock.calls,
        first.root,
        first.config.persona.agentWorkspace,
        first.workbenchRoot,
        hostPath
      );

      const runtime = new SunaRuntime(first.config, {
        attachmentService: {} as never,
        sessionStore: store,
        resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
      });
      runtimes.push(runtime);
      const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "must-not-send" }));
      runtime.activeGateway = fakeGateway(
        () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
        sendConversationAsset
      );
      enableConversationReplies(runtime, incoming);
      await driveAssetOutboxToTerminal(runtime, store, event.sessionId, "primary", () => {
        storeNow += 60_000;
      });

      const failed = store.listOutbox(event.sessionId)[0]!;
      expect(failed.error).toMatchObject({
        code: "SEND_FILE_SOURCE_UNAVAILABLE",
        message: expect.stringContaining("SEND_FILE_SOURCE_UNAVAILABLE")
      });
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      const row = inspection.prepare("SELECT result_json, error_json FROM outbox WHERE id = ?")
        .get(failed.id) as { result_json: string | null; error_json: string | null };
      inspection.close();
      const persistedError = JSON.stringify({ mapped: failed.error, row });
      expect(persistedError).toContain("SEND_FILE_SOURCE_UNAVAILABLE");
      expectSanitized(
        persistedError,
        first.root,
        first.config.persona.agentWorkspace,
        first.workbenchRoot,
        hostPath
      );
      expect(sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
    }
  });

  it("recovers a pending asset outbox from SQLite after runtime restart", async () => {
    const incoming = groupIncoming();
    const first = createHarness(incoming);
    writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-queue.sqlite");
    const before = new SessionStore({ databasePath });
    const { event } = persistAssetOutbox(before, draft, "before-restart");
    expect(before.listOutbox(event.sessionId)[0]).toMatchObject({
      status: "pending",
      payload: expect.objectContaining({
        payload: expect.objectContaining({ replyGate: draft.payload.payload.replyGate })
      })
    });
    before.close();
    first.runtime.close();
    removeTracked(runtimes, first.runtime);
    first.store.close();
    removeTracked(stores, first.store);

    const recoveredStore = new SessionStore({ databasePath });
    stores.push(recoveredStore);
    const recoveredRuntime = new SunaRuntime(first.config, {
      attachmentService: {} as never,
      sessionStore: recoveredStore,
      resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
    });
    runtimes.push(recoveredRuntime);
    const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "asset-1" }));
    recoveredRuntime.activeGateway = fakeGateway(
      () => ({
        connected: true,
        connections: 1,
        selfIds: ["4004"],
        accounts: [{ accountId: "account-b", selfId: "4004", connectedAt: new Date().toISOString() }]
      }),
      sendConversationAsset
    );
    enableConversationReplies(recoveredRuntime, incoming);

    recoveredRuntime.sessionCoordinator.resume("account-b");
    await recoveredRuntime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(sendConversationAsset).toHaveBeenCalledOnce();
    expect(recoveredStore.listOutbox(event.sessionId)[0]).toMatchObject({
      status: "sent",
      deliveryPartition: "account-b",
      payload: expect.objectContaining({
        payload: expect.objectContaining({ replyGate: draft.payload.payload.replyGate })
      })
    });
  });

  it("replays a nested delivery_unknown lineage from SQLite and sends remotely once", async () => {
    const incoming = privateIncoming();
    const first = createHarness(incoming);
    writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-nested-replay.sqlite");
    const store = new SessionStore({ databasePath });
    stores.push(store);
    const { outbox: original } = persistAssetOutbox(store, draft, "asset-nested-replay");
    const replay1 = replayAfterConfirmedUnknown(store, original, "unknown-root");
    const replay2 = replayAfterConfirmedUnknown(store, replay1, "unknown-replay-1");

    expect(store.replayUnknownOutbox({
      outboxId: replay1.id,
      confirmedNotSent: true
    }).id).toBe(replay2.id);
    expect(store.listOutbox(original.sessionId)).toHaveLength(3);

    const runtime = new SunaRuntime(first.config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
    });
    runtimes.push(runtime);
    enableConversationReplies(runtime, incoming);
    const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "asset-replay-2" }));
    runtime.activeGateway = fakeGateway(
      () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
      sendConversationAsset
    );

    runtime.sessionCoordinator.resume("primary");
    await runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(sendConversationAsset).toHaveBeenCalledOnce();
    expect(store.getOutbox(replay2.id)).toMatchObject({ status: "sent" });

    expect(store.replayUnknownOutbox({
      outboxId: replay1.id,
      confirmedNotSent: true
    })).toMatchObject({ id: replay2.id, status: "sent" });
    runtime.sessionCoordinator.resume("primary");
    await runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(sendConversationAsset).toHaveBeenCalledOnce();
    expect(store.listOutbox(original.sessionId)).toHaveLength(3);
  });

  it("rejects replay lineage tampering before any workbench read", async () => {
    const incoming = privateIncoming();
    const first = createHarness(incoming);
    writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-replay-lineage.sqlite");
    const store = new SessionStore({ databasePath });
    stores.push(store);
    const { outbox: original } = persistAssetOutbox(store, draft, "asset-replay-lineage");
    const replay1 = replayAfterConfirmedUnknown(store, original, "unknown-root");
    const replay2 = replayAfterConfirmedUnknown(store, replay1, "unknown-replay-1");
    const runtime = new SunaRuntime(first.config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
    });
    runtimes.push(runtime);
    const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "must-not-send" }));
    runtime.activeGateway = fakeGateway(
      () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
      sendConversationAsset
    );
    const inspection = new DatabaseSync(databasePath);
    const rowStatement = inspection.prepare(`
      SELECT origin_turn_id, payload_json, delivery_partition, dedupe_key, status, delivery_state
      FROM outbox WHERE id = ?
    `);
    const rowIds = [original.id, replay1.id, replay2.id];
    const rows = new Map(rowIds.map((id) => [
      id,
      rowStatement.get(id) as Record<string, string | null>
    ]));
    const turnRow = inspection.prepare("SELECT event_id FROM turns WHERE id = ?")
      .get(original.originTurnId) as { event_id: string };
    const restore = () => {
      for (const [id, row] of rows) {
        inspection.prepare(`
          UPDATE outbox
          SET origin_turn_id = ?, payload_json = ?, delivery_partition = ?, dedupe_key = ?,
              status = ?, delivery_state = ?
          WHERE id = ?
        `).run(
          row.origin_turn_id,
          row.payload_json,
          row.delivery_partition,
          row.dedupe_key,
          row.status,
          row.delivery_state,
          id
        );
      }
      inspection.prepare("UPDATE turns SET event_id = ? WHERE id = ?")
        .run(turnRow.event_id, original.originTurnId);
    };
    const cases = [
      () => inspection.prepare("UPDATE outbox SET status = 'sent', delivery_state = 'sent' WHERE id = ?")
        .run(original.id),
      () => inspection.prepare("UPDATE outbox SET status = 'sent', delivery_state = 'sent' WHERE id = ?")
        .run(replay1.id),
      () => inspection.prepare(`
        UPDATE outbox
        SET payload_json = json_set(payload_json, '$.payload.value.payload.asset.name', 'tampered.txt')
        WHERE id = ?
      `).run(replay1.id),
      () => inspection.prepare("UPDATE outbox SET delivery_partition = 'secondary' WHERE id = ?")
        .run(replay1.id),
      () => inspection.prepare("UPDATE outbox SET dedupe_key = dedupe_key || ':tampered' WHERE id = ?")
        .run(replay1.id),
      () => inspection.prepare("UPDATE outbox SET dedupe_key = dedupe_key || ':tampered' WHERE id = ?")
        .run(original.id),
      () => inspection.prepare("UPDATE outbox SET dedupe_key = 'outbox-replay:forged' WHERE id = ?")
        .run(replay2.id)
    ];
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      for (const mutate of cases) {
        mutate();
        const currentReplay = store.getOutbox(replay2.id)!;
        await expect(runtime.deliverConversationAssetOutbox(
          currentReplay,
          deliveryContext().context
        )).rejects.toMatchObject({ code: "contract_field_invalid" });
        expect(resolveFile).not.toHaveBeenCalled();
        expect(sendConversationAsset).not.toHaveBeenCalled();
        restore();
      }
      expect(() => inspection.prepare("UPDATE outbox SET origin_turn_id = 'missing-turn' WHERE id = ?")
        .run(original.id)).toThrow("FOREIGN KEY constraint failed");
      expect(() => inspection.prepare("UPDATE turns SET event_id = 'missing-event' WHERE id = ?")
        .run(original.originTurnId)).toThrow("FOREIGN KEY constraint failed");
    } finally {
      resolveFile.mockRestore();
      inspection.close();
    }
  });

  it("rejects replay lineage cycles and excessive depth before any workbench read", async () => {
    const incoming = privateIncoming();
    const first = createHarness(incoming);
    writeWorkbenchFile(first, "exports/report.txt", "report");
    const draft = await queueAsset(first, { path: "exports/report.txt", kind: "file" });
    const databasePath = path.join(first.root, "asset-replay-depth.sqlite");
    const store = new SessionStore({ databasePath });
    stores.push(store);
    const { outbox: original } = persistAssetOutbox(store, draft, "asset-replay-depth");
    const replay1 = replayAfterConfirmedUnknown(store, original, "depth-root");
    const replay2 = replayAfterConfirmedUnknown(store, replay1, "depth-1");
    const runtime = new SunaRuntime(first.config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
    });
    runtimes.push(runtime);
    const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "must-not-send" }));
    runtime.activeGateway = fakeGateway(
      () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
      sendConversationAsset
    );
    const inspection = new DatabaseSync(databasePath);
    const replay2Key = (inspection.prepare("SELECT dedupe_key FROM outbox WHERE id = ?")
      .get(replay2.id) as { dedupe_key: string }).dedupe_key;
    const resolveFile = vi.spyOn(agentServices, "resolveAgentWorkbenchFile");
    try {
      inspection.prepare("UPDATE outbox SET dedupe_key = ? WHERE id = ?")
        .run(`outbox-replay:${replay2.id}:${"0".repeat(64)}`, replay2.id);
      await expect(runtime.deliverConversationAssetOutbox(
        store.getOutbox(replay2.id)!,
        deliveryContext().context
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveFile).not.toHaveBeenCalled();
      expect(sendConversationAsset).not.toHaveBeenCalled();

      inspection.prepare("UPDATE outbox SET dedupe_key = ? WHERE id = ?").run(replay2Key, replay2.id);
      let deepest = replay2;
      for (let depth = 2; depth < 9; depth += 1) {
        deepest = replayAfterConfirmedUnknown(store, deepest, `depth-${depth}`);
      }
      await expect(runtime.deliverConversationAssetOutbox(
        store.getOutbox(deepest.id)!,
        deliveryContext().context
      )).rejects.toMatchObject({ code: "contract_field_invalid" });
      expect(resolveFile).not.toHaveBeenCalled();
      expect(sendConversationAsset).not.toHaveBeenCalled();
    } finally {
      resolveFile.mockRestore();
      inspection.close();
    }
  });
});

interface Harness {
  root: string;
  workbenchRoot: string;
  config: ReturnType<typeof createAdminTestConfig>;
  runtime: SunaRuntime;
  store: SessionStore;
  gateway: MessagingPort;
  sendConversationAsset: ReturnType<typeof vi.fn>;
  incoming: ParsedIncomingMessage;
}

function createHarness(
  incoming: ParsedIncomingMessage,
  getStatus: () => MessagingStatusV1 = () => ({ connected: true, connections: 1, selfIds: ["4004"] })
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sunabot-runtime-assets-"));
  roots.push(root);
  const config = createAdminTestConfig(root);
  const store = new SessionStore({ databasePath: ":memory:" });
  stores.push(store);
  const runtime = new SunaRuntime(config, {
    attachmentService: {} as never,
    sessionStore: store,
    resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
  });
  runtimes.push(runtime);
  enableConversationReplies(runtime, incoming);
  const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "asset-1" }));
  const gateway = fakeGateway(getStatus, sendConversationAsset);
  runtime.activeGateway = gateway;
  return {
    root,
    workbenchRoot: path.join(config.persona.agentWorkspace, "workbench"),
    config,
    runtime,
    store,
    gateway,
    sendConversationAsset,
    incoming
  };
}

function enableConversationReplies(runtime: SunaRuntime, incoming: ParsedIncomingMessage) {
  const record = runtime.recordIncomingMessage(incoming);
  if (incoming.transport === "web") return;
  runtime.setConversationReplyEnabled({ id: record.id, replyEnabled: true });
}

async function queueAsset(
  harness: Harness,
  input: { path: string; kind: "auto" | "file" | "image"; name?: string }
) {
  const authoritativeIncoming = structuredClone(harness.incoming);
  let draft: ConversationAssetDeliveryDraft | undefined;
  const delivery: ReplyDelivery = {
    outbox: [],
    emitOutbox: async (value) => { draft = value as ConversationAssetDeliveryDraft; }
  };
  await harness.runtime.queueConversationAsset({
    incoming: harness.incoming,
    gateway: harness.gateway,
    input,
    callId: "call-send-file",
    logRunId: "run-send-file",
    isCurrent: () => true,
    delivery
  });
  if (!draft) throw new Error("asset draft was not emitted");
  persistedDraftIncoming.set(draft, authoritativeIncoming);
  return draft;
}

function outboxRecord(harness: Harness, draft: ConversationAssetDeliveryDraft): OutboxRecord {
  const existing = persistedOutboxes.get(draft);
  if (existing) return existing;
  const { outbox } = persistAssetOutbox(harness.store, draft, `asset-direct-${++persistedOutboxSequence}`);
  persistedOutboxes.set(draft, outbox);
  return outbox;
}

function persistAssetOutbox(
  store: SessionStore,
  draft: ConversationAssetDeliveryDraft,
  workerId: string,
  authoritativeIncoming?: ParsedIncomingMessage,
  authoritativeSessionId = draft.payload.conversationId
) {
  authoritativeIncoming ??= persistedDraftIncoming.get(draft);
  if (!authoritativeIncoming) throw new Error("asset fixture authoritative incoming is missing");
  const sessionId = authoritativeSessionId;
  if (!sessionId) throw new Error("asset fixture conversationId is missing");
  const queued = store.enqueueEvent({
    sessionId,
    kind: "incoming_reply",
    payload: incomingReplyEnvelope({
      type: "incoming_reply",
      route: "direct",
      incoming: authoritativeIncoming,
      captureSequence: 1,
      replyGate: draft.payload.payload.replyGate,
      replyQuote: {
        enabled: false,
        replyToMessageId: null
      }
    }, {
      conversationId: sessionId,
      correlationId: `asset-fixture:${workerId}`
    })
  });
  const claim = store.claimNextTurn({ workerId, sessionId });
  if (!claim) throw new Error("asset fixture turn was not claimed");
  const appended = store.appendTurnOutbox({
    turnId: claim.turn.id,
    workerId,
    dedupeKey: `turn-outbox:${queued.event.id}:1`,
    draft
  });
  store.finishTurn({
    turnId: claim.turn.id,
    workerId,
    outcome: "replied"
  });
  return { event: queued.event, outbox: appended.outbox };
}

function replayAfterConfirmedUnknown(store: SessionStore, outbox: OutboxRecord, workerId: string) {
  const claimed = store.claimNextOutbox({ workerId });
  expect(claimed).toMatchObject({ id: outbox.id, status: "sending" });
  store.markOutboxTransportStarted(outbox.id, workerId);
  store.finishOutbox({
    outboxId: outbox.id,
    workerId,
    outcome: "delivery_unknown"
  });
  return store.replayUnknownOutbox({
    outboxId: outbox.id,
    confirmedNotSent: true
  });
}

function assetDraftFingerprint(draft: ConversationAssetDeliveryDraft) {
  const payload = draft.payload.payload;
  return hashCanonical({
    schemaVersion: 2,
    type: payload.type,
    target: payload.target,
    incomingFingerprint: payload.incomingFingerprint,
    toolName: payload.toolName,
    asset: payload.asset
  });
}

function assetIdempotencyKey(draft: ConversationAssetDeliveryDraft) {
  return `conversation-asset:${hashCanonical({
    schemaVersion: 2,
    payload: draft.payload.payload
  })}`;
}

function hashCanonical(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().flatMap((key) => {
    const item = record[key];
    return item === undefined ? [] : [`${JSON.stringify(key)}:${stableJson(item)}`];
  }).join(",")}}`;
}

function deliveryContext(options: {
  settleStep?: OutboxDeliveryContext["settleStep"];
} = {}) {
  let phase: OutboxDeliveryContext["phase"] = "send";
  let remoteReceipt: unknown;
  const completedSteps = new Set<string>();
  const context: OutboxDeliveryContext = {
    signal: new AbortController().signal,
    get phase() { return phase; },
    get remoteReceipt() { return remoteReceipt; },
    async sendRemote(operation) {
      remoteReceipt = await operation();
      phase = "settle";
      return remoteReceipt;
    },
    settleStep: options.settleStep ?? (async (step, operation) => {
      if (completedSteps.has(step)) return undefined;
      const result = await operation(`outbox:asset:settle:${step}`);
      completedSteps.add(step);
      return result;
    }),
    async settleEffectStep(step, operation) {
      if (completedSteps.has(step)) return undefined;
      const result = await operation(`outbox:asset:settle:${step}`);
      completedSteps.add(step);
      return result;
    }
  };
  return { context };
}

function fakeGateway(
  getStatus: () => MessagingStatusV1,
  sendConversationAsset: ReturnType<typeof vi.fn>
) {
  return {
    getStatus: vi.fn(getStatus),
    send: vi.fn(async () => ({ accepted: true as const })),
    sendConversationAsset,
    resolveSender: vi.fn(async ({ userId, current }) => current ?? { id: String(userId) }),
    getMessage: vi.fn(async () => ({
      text: "",
      media: [],
      attachments: [],
      replyMessageIds: [],
      sender: { id: "2002" }
    }))
  } as unknown as MessagingPort;
}

function writeWorkbenchFile(harness: Harness, relativePath: string, content: string | Buffer) {
  const filePath = path.join(harness.workbenchRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function privateIncoming(userId = 171419991): ParsedIncomingMessage {
  return incoming({ scope: "private", userId });
}

function groupIncoming(userId = 171419991): ParsedIncomingMessage {
  return incoming({ scope: "user_group", groupId: 602, accountId: "account-b", userId });
}

function incoming(options: {
  scope: ParsedIncomingMessage["scope"];
  groupId?: number;
  accountId?: string;
  userId?: number;
}): ParsedIncomingMessage {
  const userId = options.userId ?? 171419991;
  return {
    schemaVersion: 1,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    scope: options.scope,
    messageId: 19_980,
    time: new Date().toISOString(),
    userId,
    ...(options.groupId ? { groupId: options.groupId } : {}),
    selfId: 4004,
    sender: { id: String(userId), nickname: "tester", displayName: "tester" },
    text: "发送报告",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: true
  };
}

function removeTracked<T>(values: T[], value: T) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function expectSanitized(value: unknown, ...sensitivePaths: string[]) {
  const encoded = value instanceof Error
    ? JSON.stringify({ name: value.name, message: value.message, code: (value as NodeJS.ErrnoException).code })
    : JSON.stringify(value);
  for (const sensitivePath of sensitivePaths.filter(Boolean)) {
    expect(encoded).not.toContain(sensitivePath);
  }
}

async function driveAssetOutboxToTerminal(
  runtime: SunaRuntime,
  store: SessionStore,
  sessionId: string,
  deliveryPartition: string,
  advanceStoreClock: () => void
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    runtime.sessionCoordinator.resume(deliveryPartition);
    await runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    const status = store.listOutbox(sessionId)[0]?.status;
    if (status === "dead" || status === "sent" || status === "delivery_unknown") return;
    advanceStoreClock();
  }
  throw new Error("Conversation asset outbox did not reach a terminal state.");
}

async function executeSendFileTool(harness: Harness, relativePath: string) {
  const executor = new RegistryProviderToolExecutor();
  const options = {
    conversationAssets: {
      enabled: true,
      send: (input, context) => harness.runtime.queueConversationAsset({
        incoming: harness.incoming,
        gateway: harness.gateway,
        input,
        callId: context.callId,
        logRunId: "run-tool-error",
        isCurrent: () => true,
        delivery: { outbox: [], emitOutbox: vi.fn(async () => undefined) }
      })
    }
  } satisfies ProviderCompleteOptions;
  const definitions = executor.resolveDefinitions(options, [{ type: "function", function: sendFileTool }]);
  const [output] = await executor.execute([{
    type: "function_call",
    name: "send_file",
    call_id: "call-tool-error",
    arguments: JSON.stringify({ path: relativePath, kind: "file", name: null })
  }], options, definitions);
  return JSON.parse(String(output?.output)) as { ok: boolean; error?: string };
}
