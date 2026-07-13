// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConversationRoutes } from "../../apps/api/plugins/conversationRoutes.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import type { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import { SunaRuntime } from "../../src/runtime.js";
import { appendRequestLog } from "../../src/requestLog.js";
import { applicationDataStore, closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  closeApplicationDataStores();
});

describe("conversation API plugin", () => {
  it("registers schemas and preserves conversation delegation", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));
    app.setErrorHandler((error, _request, reply) => error instanceof ServiceError
      ? reply.status(error.statusCode).send(error.toJSON())
      : reply.send(error));

    const records = [{ id: "private:171419991", title: "管理员", messageCount: 12 }];
    const hydrateConversationRecords = vi.fn(async () => undefined);
    const hydrateConversationIdentities = vi.fn(async () => undefined);
    const getConversationMessages = vi.fn(() => ({ messages: [{ role: "user", content: "hello" }] }));
    const messageStats = {
      total: 12,
      retained: 12,
      visible: 11,
      user: 6,
      assistant: 5,
      internal: 1
    };
    const setConversationReplyEnabled = vi.fn((body: unknown) => body);
    const runtime = {
      getConversationRecords: vi.fn(() => records),
      hydrateConversationRecords,
      hydrateConversationIdentities,
      getConversationMessages,
      getConversationMessageStats: vi.fn(() => messageStats),
      setConversationReplyEnabled
    } as unknown as SunaRuntime;
    const onebotGateway = { getStatus: vi.fn(() => ({ connected: true })) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(async (value: unknown) => value),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;

    registerConversationRoutes(app, { runtime, onebotGateway, conversationDirectory });

    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json())
      .toEqual({ conversations: records });
    expect(hydrateConversationRecords).toHaveBeenCalledWith(onebotGateway);

    expect((await app.inject({
      method: "GET",
      url: "/api/conversations/private%3A171419991/messages?before=12&limit=5"
    })).json()).toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(hydrateConversationIdentities).toHaveBeenCalledWith("private:171419991", onebotGateway);
    expect(getConversationMessages).toHaveBeenCalledWith("private:171419991", {
      beforeSequence: 12,
      limit: 5
    });

    expect((await app.inject({
      method: "GET",
      url: "/api/conversations/private%3A171419991/stats"
    })).json()).toMatchObject({
      conversationId: "private:171419991",
      messages: messageStats,
      modelCalls: { conversationId: "private:171419991" }
    });

    expect((await app.inject({ method: "GET", url: "/api/web-chat/messages" })).json())
      .toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(getConversationMessages).toHaveBeenCalledWith("web:admin", { limit: 200 });
    for (const invalid of [
      { text: "", message: "请输入消息。" },
      { text: "x".repeat(16_001), message: "消息不能超过 16000 个字符。" }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/web-chat/messages",
        payload: { text: invalid.text }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "WEB_CHAT_MESSAGE_INVALID",
          message: invalid.message,
          field: "text"
        }
      });
    }

    const replyBody = { id: "private:171419991", replyEnabled: false };
    expect((await app.inject({
      method: "PUT",
      url: "/api/conversations/reply",
      payload: replyBody
    })).json()).toEqual({ ok: true, conversation: replyBody });
    expect(setConversationReplyEnabled).toHaveBeenCalledWith(replyBody);

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/conversations",
      "/api/conversations/:id/logs",
      "/api/conversations/:id/messages",
      "/api/conversations/:id/stats",
      "/api/conversations/reply",
      "/api/web-chat/messages"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });

  it("keeps a valid Web Chat turn alive after the HTTP request body closes", async () => {
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => error instanceof ServiceError
      ? reply.status(error.statusCode).send(error.toJSON())
      : reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: String(error) } }));

    const messages: Array<Record<string, unknown>> = [];
    const replyToIncoming = vi.fn(async (
      _channel: string,
      _incoming: unknown,
      delivery: { send(message: Record<string, unknown>): Promise<unknown> },
      options: { signal?: AbortSignal }
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (options.signal?.aborted) throw options.signal.reason;
      const reply = {
        schemaVersion: 1,
        id: "web-reply",
        conversationId: "web:admin",
        scope: "private",
        userId: 171419991,
        text: "连接正常",
        media: []
      };
      await delivery.send(reply);
      messages.push({ id: reply.id, role: "assistant", text: reply.text, at: new Date().toISOString() });
    });
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => messages.length + 1,
      recordIncomingMessage: (incoming: { messageId: number; text: string; time: string }) => {
        messages.push({ id: String(incoming.messageId), role: "user", text: incoming.text, at: incoming.time });
      },
      replyToIncoming,
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [...messages],
        hasMore: false,
        memberNames: {}
      }),
      getConversationRecords: () => [],
      setConversationReplyEnabled: vi.fn()
    } as unknown as SunaRuntime;
    const onebotGateway = { getStatus: () => ({ connected: false }) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;
    registerConversationRoutes(app, { runtime, onebotGateway, conversationDirectory });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Fastify test server has no TCP address.");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/web-chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "请确认连接" })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      delivered: 1,
      conversationId: "web:admin",
      messages: [
        { role: "user", text: "请确认连接" },
        { role: "assistant", text: "连接正常" }
      ]
    });
    expect(replyToIncoming).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent HTTP sends with stable per-Agent Web Chat message ids", async () => {
    const app = Fastify();
    apps.push(app);
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    const secondRuntimeLookup = deferred<void>();
    const started: string[] = [];
    const messageIds: number[] = [];
    vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);

    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: (incoming: { messageId: number }) => {
        messageIds.push(incoming.messageId);
      },
      replyToIncoming: vi.fn(async (_channel: string, incoming: { text: string }) => {
        started.push(incoming.text);
        if (incoming.text === "第一条") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      }),
      getConversationRecords: () => [],
      setConversationReplyEnabled: vi.fn()
    } as unknown as SunaRuntime;
    const onebotGateway = { getStatus: () => ({ connected: false }) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;
    let runtimeLookups = 0;
    registerConversationRoutes(app, {
      runtime,
      getRuntime: () => {
        runtimeLookups += 1;
        if (runtimeLookups === 2) secondRuntimeLookup.resolve();
        return runtime;
      },
      onebotGateway,
      conversationDirectory
    });

    const first = app.inject({
      method: "POST",
      url: "/api/web-chat/messages",
      payload: { text: "第一条" }
    });
    await firstStarted.promise;
    const second = app.inject({
      method: "POST",
      url: "/api/web-chat/messages",
      payload: { text: "第二条" }
    });
    await secondRuntimeLookup.promise;
    await Promise.resolve();
    await Promise.resolve();
    const startedBeforeRelease = [...started];
    const messageIdsBeforeRelease = [...messageIds];
    releaseFirst.resolve();
    const responses = await Promise.all([first, second]);

    expect(startedBeforeRelease).toEqual(["第一条"]);
    expect(messageIdsBeforeRelease).toEqual([1_750_000_000_000_000]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(started).toEqual(["第一条", "第二条"]);
    expect(messageIds).toEqual([
      1_750_000_000_000_000,
      1_750_000_000_000_001
    ]);
  });

  it("writes Arona Web Chat request logs and token aggregates to the Arona database", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-web-chat-agent-"));
    const app = Fastify();
    apps.push(app);
    const planaConfig = createAdminTestConfig(root);
    planaConfig.persona.agentWorkspace = path.join(root, "business", "agents", "plana");
    const aronaConfig = structuredClone(planaConfig);
    aronaConfig.persona = {
      ...aronaConfig.persona,
      defaultAgentId: "arona",
      name: "阿罗娜",
      agentWorkspace: path.join(root, "business", "agents", "arona")
    };
    const aronaRuntime = new SunaRuntime(aronaConfig, { attachmentService: {} as never });
    const internals = aronaRuntime as unknown as {
      reply: {
        replyToIncoming(): Promise<void>;
      };
      adminIdentity(): { userId: string; name: string };
      incomingCaptureSequence(): number;
      recordIncomingMessage(): void;
      getConversationMessages(): Record<string, unknown>;
    };
    internals.reply = {
      replyToIncoming: async () => {
        await appendRequestLog({
          category: "model.response",
          action: "responses.complete",
          model: "gpt-arona",
          response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } },
          metadata: { conversationId: "web:admin", stage: "reply" }
        });
      }
    };
    internals.adminIdentity = () => ({ userId: "171419991", name: "管理员" });
    internals.incomingCaptureSequence = () => 1;
    internals.recordIncomingMessage = () => undefined;
    internals.getConversationMessages = () => ({
      conversationId: "web:admin",
      messages: [],
      hasMore: false,
      memberNames: {}
    });

    const planaRuntime = {
      config: planaConfig
    } as unknown as SunaRuntime;
    const getRuntime = vi.fn((agentId: string) => agentId === "arona" ? aronaRuntime : planaRuntime);
    const onebotGateway = { getStatus: () => ({ connected: false }) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;
    registerConversationRoutes(app, {
      runtime: planaRuntime,
      getRuntime,
      onebotGateway,
      conversationDirectory
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/web-chat/messages?agentId=arona",
        payload: { text: "测试选库" }
      });

      expect(response.statusCode).toBe(200);
      expect(getRuntime).toHaveBeenCalledWith("arona");
      expect(applicationDataStore(aronaConfig).readRequestLogs({ query: "web:admin", limit: 20 }))
        .toEqual([expect.objectContaining({ action: "responses.complete", model: "gpt-arona" })]);
      expect(applicationDataStore(aronaConfig).readModelCallAggregateRows("web:admin"))
        .toEqual([expect.objectContaining({ behavior: "reply", requests: 1, total: 10 })]);
      expect(applicationDataStore(planaConfig).readRequestLogs({ query: "web:admin", limit: 20 })).toEqual([]);
    } finally {
      aronaRuntime.close();
      closeApplicationDataStores();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
