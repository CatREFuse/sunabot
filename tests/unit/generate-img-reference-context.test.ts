// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";
import { toContextChatMessage } from "../../src/runtime/conversationMemoryHelpers.js";
import {
  runtime_buildRecentContextMessages,
  runtime_generateImgReferenceContext,
  runtime_processDeferredToolJob
} from "../../src/runtime/reply.js";
import { MESSAGE_32_CONTEXT_TOKEN_BUDGET } from "../../src/runtime/runtimeContracts.js";
import {
  runtime_collectSelfieChatReferenceImages,
  runtime_loadSelfieReferenceImages,
  runtime_runSelfie
} from "../../src/runtime/selfie.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";
import { runGenerateImg } from "../../services/tools/generateImgTool.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("generate_img historical reference context", () => {
  it("excludes internal orchestrator audit records from model conversation history", () => {
    const incoming = incomingMessage();
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 3,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: "visible-user",
          role: "user",
          sequence: 1,
          text: "正常群聊历史"
        }),
        conversationMessage({
          id: "internal-orchestrator",
          role: "assistant",
          sequence: 2,
          text: "编排器结果",
          visibility: "internal",
          eventKind: "orchestrator_decision",
          orchestratorDecision: {
            status: "completed",
            shouldReply: false,
            reason: "仅供内部审计",
            raw: "{}"
          }
        }),
        conversationMessage({
          id: String(incoming.messageId),
          role: "user",
          sequence: 3
        })
      ]
    };

    const messages = runtime_buildRecentContextMessages.call({
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48,
      adminIdentity: () => ({ userId: "9", name: "Admin" })
    } as never, incoming, 3);

    expect(messages.map((message) => message.content)).toEqual([
      expect.stringContaining("正常群聊历史")
    ]);
    expect(JSON.stringify(messages)).not.toContain("编排器结果");
    expect(JSON.stringify(messages)).not.toContain("仅供内部审计");
  });

  it("keeps an oversized latest message outside the message_32 token budget", () => {
    const incoming = incomingMessage();
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 2,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: "oversized-history",
          role: "user",
          sequence: 1,
          text: "超".repeat(5_000)
        }),
        conversationMessage({
          id: String(incoming.messageId),
          role: "user",
          sequence: 2
        })
      ]
    };

    const messages = runtime_buildRecentContextMessages.call({
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 32,
      adminIdentity: () => ({ userId: "9", name: "Admin" })
    } as never, incoming, 2, 32, MESSAGE_32_CONTEXT_TOKEN_BUDGET);

    expect(messages).toEqual([]);
  });

  it("exposes stable media handles to the model", () => {
    const message = conversationMessage({
      id: "generated-1",
      role: "assistant",
      imageUrls: ["/generated-images/agents/arona/result.png"]
    });

    expect(toContextChatMessage(message, false, { userId: "9", name: "Admin" }).content)
      .toContain("message:generated-1:image:0");
  });

  it("passes a sent catalog emoji handle through the next generate_img call", async () => {
    const incoming = incomingMessage();
    const emojiUrl = "/generated-images/conversation-assets/agents/arona/emoji.png";
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 2,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: "sent-catalog-emoji",
          role: "assistant",
          sequence: 0,
          imageUrls: [emojiUrl]
        }),
        conversationMessage({
          id: String(incoming.messageId),
          role: "user",
          sequence: 1
        })
      ]
    };
    const references = runtime_generateImgReferenceContext.call({
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48
    } as never, incoming, 2);
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/agents/arona/output.png",
      filePath: "/tmp/output.png"
    }));

    await runGenerateImg({
      prompt: "use the exact sent sticker",
      referenceMediaHandles: ["message:sent-catalog-emoji:image:0"],
      referenceImageSource: "none"
    }, createAdminTestConfig(process.cwd()).bot, generateImage, {
      imageReferences: references
    });

    expect(generateImage.mock.calls[0]?.[3]).toEqual([emojiUrl]);
  });

  it("keeps explicit handles conversation-scoped while automatic history stays on the same user", () => {
    const incoming = incomingMessage();
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: "user_group",
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 6,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({ id: "generated-old", role: "assistant", sequence: 0, userId: 100, imageUrls: ["/generated-images/agents/arona/old.png"] }),
        conversationMessage({ id: "original", role: "user", sequence: 1, userId: 100, imageUrls: ["https://example.test/original.png"] }),
        conversationMessage({ id: "other-user", role: "user", sequence: 2, userId: 200, imageUrls: ["https://example.test/other.png"] }),
        conversationMessage({ id: "generated", role: "assistant", sequence: 3, userId: 100, imageUrls: ["/generated-images/agents/arona/generated.png"] }),
        conversationMessage({ id: String(incoming.messageId), role: "user", sequence: 4, userId: 100 }),
        conversationMessage({ id: "later", role: "assistant", sequence: 5, userId: 100, imageUrls: ["/generated-images/agents/arona/later.png"] })
      ]
    };
    const host = {
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48
    };

    const references = runtime_generateImgReferenceContext.call(host as never, incoming, 4);

    expect(references.currentImageUrls).toEqual([]);
    expect(references.previousOutputImageUrls).toEqual(["/generated-images/agents/arona/generated.png"]);
    expect(references.historyImageUrls).toEqual([
      "/generated-images/agents/arona/generated.png",
      "https://example.test/original.png",
      "/generated-images/agents/arona/old.png"
    ]);
    expect(references.mediaByHandle).toMatchObject({
      "message:generated:image:0": "/generated-images/agents/arona/generated.png",
      "message:other-user:image:0": "https://example.test/other.png"
    });
    expect(references.mediaByHandle).not.toHaveProperty("message:later:image:0");
  });

  it("freezes the current message image under the exact handle exposed to the model", () => {
    const incoming = incomingMessage();
    incoming.media = [{
      schemaVersion: 1,
      kind: "image",
      source: "remote_url",
      url: "https://example.test/current.png"
    }];
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 1,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: String(incoming.messageId),
          role: "user",
          sequence: 1,
          imageUrls: ["https://example.test/current.png"]
        })
      ]
    };

    const references = runtime_generateImgReferenceContext.call({
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48
    } as never, incoming, 1);

    expect(references.currentImageUrls).toEqual(["https://example.test/current.png"]);
    expect(references.mediaByHandle).toMatchObject({
      "message:400:image:0": "https://example.test/current.png"
    });
  });

  it("freezes quoted image handles under the quoted message ID exposed to the model", () => {
    const incoming = incomingMessage();
    incoming.quoteReferences = [{
      messageId: 399,
      media: [{
        schemaVersion: 1,
        kind: "image",
        source: "remote_url",
        url: "https://example.test/quoted.png"
      }]
    }];

    const references = runtime_generateImgReferenceContext.call({
      conversationRecords: new Map(),
      contextMessageLimit: () => 48
    } as never, incoming, 1);

    expect(references.mediaByHandle).toMatchObject({
      "message:399:image:0": "https://example.test/quoted.png"
    });
  });

  it("fails before generation when an explicitly requested media handle cannot be resolved", async () => {
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/agents/arona/output.png",
      filePath: "/tmp/output.png"
    }));

    const result = await runGenerateImg({
      prompt: "edit the exact current image",
      referenceMediaHandles: ["message:400:image:0"],
      referenceImageSource: "none"
    }, createAdminTestConfig(process.cwd()).bot, generateImage, {
      imageReferences: {
        currentImageUrls: ["https://example.test/current.png"],
        mediaByHandle: {}
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: "One or more reference media handles are unavailable.",
      referenceMediaHandleCount: 1,
      resolvedReferenceMediaHandleCount: 0
    });
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("uses the dispatch-time media snapshot when the deferred image job runs", async () => {
    const incoming = incomingMessage();
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/agents/arona/output.png",
      filePath: "/tmp/output.png"
    }));
    const host = {
      config: createAdminTestConfig(process.cwd()),
      getProvider: () => ({ generateImage }),
      getProviderForModel: () => ({ generateImage }),
      conversationRecords: new Map(),
      contextMessageLimit: () => 48
    };
    const result = await runtime_processDeferredToolJob.call(host as never, {
      id: "job-image-1",
      toolName: "generate_img",
      arguments: {
        prompt: "edit the selected image",
        referenceImageUrls: null,
        referenceImagePaths: ["references/workbench.png"],
        referenceMediaHandles: ["message:generated:image:0"],
        referenceImageSource: "none"
      },
      originalRequest: {
        incoming,
        captureSequence: 4,
        imageReferences: {
          mediaByHandle: {
            "message:generated:image:0": "/generated-images/agents/arona/generated.png"
          }
        },
        workbenchImagesByPath: {
          "references/workbench.png": "/generated-images/conversation-assets/agents/arona/workbench.png"
        }
      }
    } as never, new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(generateImage).toHaveBeenCalledWith(
      "edit the selected image",
      expect.any(String),
      expect.any(String),
      [
        "/generated-images/agents/arona/generated.png",
        "/generated-images/conversation-assets/agents/arona/workbench.png"
      ],
      expect.objectContaining({ stage: "async_image_tool" }),
      expect.anything()
    );
  });

  it("does not persist image history after a deferred image deadline aborts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-deferred-image-late-"));
    const config = createAdminTestConfig(root);
    const lateImage = deferred<{
      url: string;
      filePath: string;
    }>();
    const generateImage = vi.fn(async () => lateImage.promise);
    const incoming = incomingMessage();
    const controller = new AbortController();
    const timeout = new DOMException("image task timed out", "TimeoutError");
    const host = {
      config,
      getProvider: () => ({ generateImage }),
      getProviderForModel: () => ({ generateImage }),
      conversationRecords: new Map(),
      contextMessageLimit: () => 48
    };
    try {
      const processing = runtime_processDeferredToolJob.call(host as never, {
        id: "job-image-late",
        toolName: "generate_img",
        arguments: {
          prompt: "draw after a delay",
          referenceImageSource: "none"
        },
        originalRequest: { incoming }
      } as never, controller.signal);
      await vi.waitFor(() => expect(generateImage).toHaveBeenCalledOnce());

      controller.abort(timeout);
      lateImage.resolve({
        url: "/generated-images/agents/arona/late.png",
        filePath: path.join(root, "late.png")
      });

      await expect(processing).rejects.toBe(timeout);
      expect(applicationDataStore(config).readImageHistory()).toEqual([]);
    } finally {
      closeApplicationDataStores();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps deferred selfie chat references inside the dispatch-time debounce boundary", async () => {
    const incoming = incomingMessage();
    const record: ConversationRecord = {
      id: conversationRecordId(incoming),
      accountId: incoming.accountId,
      agentId: incoming.agentId,
      scope: incoming.scope,
      title: "group",
      userId: incoming.userId,
      groupId: incoming.groupId,
      messageCount: 4,
      lastAt: incoming.time,
      lastText: incoming.text,
      messages: [
        conversationMessage({
          id: "inside-boundary",
          role: "user",
          sequence: 1,
          imageUrls: ["https://example.test/inside.png"]
        }),
        conversationMessage({
          id: "after-handoff",
          role: "user",
          sequence: 3,
          imageUrls: ["https://example.test/after.png"]
        })
      ]
    };
    const runSelfie = vi.fn(async () => ({ ok: true, image: { url: "/selfie.png" } }));
    const host = {
      config: createAdminTestConfig(process.cwd()),
      getProvider: () => ({}),
      getProviderForModel: () => ({}),
      conversationRecords: new Map([[record.id, record]]),
      contextMessageLimit: () => 48,
      collectSelfieChatReferenceImages: runtime_collectSelfieChatReferenceImages,
      runSelfie
    };

    const result = await runtime_processDeferredToolJob.call(host as never, {
      id: "job-selfie-1",
      toolName: "selfie",
      arguments: { prompt: "take a selfie" },
      originalRequest: {
        incoming,
        captureSequence: 99,
        contextThroughSequence: 2
      }
    } as never, new AbortController().signal);

    expect(result.status).toBe("succeeded");
    expect(runSelfie).toHaveBeenCalledOnce();
    expect(runSelfie.mock.calls[0]?.[2]).toMatchObject({
      chatReferenceImageUrls: ["https://example.test/inside.png"]
    });

    runSelfie.mockClear();
    const legacyResult = await runtime_processDeferredToolJob.call(host as never, {
      id: "job-selfie-legacy",
      toolName: "selfie",
      arguments: { prompt: "take a legacy selfie" },
      originalRequest: { incoming, captureSequence: 2 }
    } as never, new AbortController().signal);

    expect(legacyResult.status).toBe("succeeded");
    expect(runSelfie.mock.calls[0]?.[2]).toMatchObject({
      chatReferenceImageUrls: ["https://example.test/inside.png"]
    });
  });

  it("shares one task signal across selfie prompt rewrite and image generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-budget-"));
    try {
      const config = createAdminTestConfig(root);
      const selfieDirectory = path.join(config.persona.agentWorkspace, "workbench", "selfie");
      const imageBytes = Buffer.from("selfie-budget-reference");
      const referenceId = crypto.createHash("sha256").update(imageBytes).digest("hex");
      await fs.mkdir(selfieDirectory, { recursive: true });
      await fs.writeFile(path.join(selfieDirectory, "reference.png"), imageBytes);
      const rewriteSelfiePrompt = vi.fn(async (
        _provider: unknown,
        _prompt: string,
        _size: string,
        _references: unknown,
        _logContext: unknown,
        signal: AbortSignal
      ) => ({
        prompt: "rewritten selfie",
        selectedSelfieReferenceIds: [referenceId],
        signal
      }));
      let rewriteSignal: AbortSignal | undefined;
      rewriteSelfiePrompt.mockImplementation(async (
        _provider,
        _prompt,
        _size,
        _references,
        _logContext,
        signal
      ) => {
        rewriteSignal = signal;
        return {
          prompt: "rewritten selfie",
          selectedSelfieReferenceIds: [referenceId],
          signal
        };
      });
      let imageSignal: AbortSignal | undefined;
      const provider = {
        generateImage: vi.fn(async (
          _prompt: string,
          _size: string,
          _quality: string,
          _references: string[],
          _logContext: unknown,
          signal: AbortSignal
        ) => {
          imageSignal = signal;
          return { url: "/generated-images/selfie-budget.png" };
        })
      };
      const caller = new AbortController();

      await expect(runtime_runSelfie.call({
        config,
        rewriteSelfiePrompt
      } as never, {
        prompt: "take a selfie"
      }, provider as never, {
        signal: caller.signal
      })).resolves.toMatchObject({ ok: true });

      expect(rewriteSignal).toBe(caller.signal);
      expect(imageSignal).toBe(rewriteSignal);
      caller.abort(new DOMException("cancelled", "AbortError"));
      expect(imageSignal?.aborted).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads selfie references without treating array indexes as abort signals", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-load-"));
    try {
      const config = createAdminTestConfig(root);
      const selfieDirectory = path.join(config.persona.agentWorkspace, "workbench", "selfie");
      await fs.mkdir(selfieDirectory, { recursive: true });
      await fs.writeFile(
        path.join(selfieDirectory, "reference.png"),
        Buffer.from("selfie-load-reference")
      );

      await expect(runtime_loadSelfieReferenceImages.call({ config } as never))
        .resolves.toEqual([expect.stringMatching(/^data:image\/png;base64,/u)]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function incomingMessage(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "user_group",
    messageId: 400,
    time: "2026-07-14T01:00:00.000Z",
    userId: 100,
    groupId: 300,
    selfId: 500,
    sender: { id: "100", displayName: "User" },
    text: "继续修改上一张",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: true,
    accountId: "primary",
    agentId: "arona"
  };
}

function conversationMessage(input: Partial<ConversationRecord["messages"][number]> & Pick<ConversationRecord["messages"][number], "id" | "role">) {
  return {
    text: input.imageUrls?.length ? "[图片]" : "message",
    at: "2026-07-14T00:00:00.000Z",
    userId: 100,
    ...input
  } satisfies ConversationRecord["messages"][number];
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
