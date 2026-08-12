// @vitest-environment node
import { EventEmitter } from "node:events";
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
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
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
    const getConversationToolPolicy = vi.fn((id: string) => ({ conversationId: id, disabledTools: ["websearch"] }));
    const setConversationToolPolicy = vi.fn((body: unknown) => body);
    const runtime = {
      getConversationRecords: vi.fn(() => records),
      hydrateConversationRecords,
      hydrateConversationIdentities,
      getConversationMessages,
      getConversationMessageStats: vi.fn(() => messageStats),
      setConversationReplyEnabled,
      getConversationToolPolicy,
      setConversationToolPolicy
    } as unknown as SunaRuntime;
    const onebotGateway = { getStatus: vi.fn(() => ({ connected: true })) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(async (value: unknown) => value),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;

    registerConversationRoutes(app, { runtime, onebotGateway, conversationDirectory });

    expect((await app.inject({ method: "GET", url: "/api/conversations?agentId=plana" })).json())
      .toEqual({ conversations: records });
    expect(hydrateConversationRecords).toHaveBeenCalledWith(onebotGateway);

    expect((await app.inject({
      method: "GET",
      url: "/api/conversations/private%3A171419991/messages?agentId=plana&before=12&limit=5"
    })).json()).toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(hydrateConversationIdentities).toHaveBeenCalledWith("private:171419991", onebotGateway);
    expect(getConversationMessages).toHaveBeenCalledWith("private:171419991", {
      beforeSequence: 12,
      limit: 5
    });

    expect((await app.inject({
      method: "GET",
      url: "/api/conversations/private%3A171419991/stats?agentId=plana"
    })).json()).toMatchObject({
      conversationId: "private:171419991",
      messages: messageStats,
      modelCalls: { conversationId: "private:171419991" }
    });

    expect((await app.inject({ method: "GET", url: "/api/web-chat/messages?agentId=plana" })).json())
      .toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(getConversationMessages).toHaveBeenCalledWith("web:admin", { limit: 200 });
    for (const invalid of [
      { text: "", message: "请输入消息。" },
      { text: "x".repeat(16_001), message: "消息不能超过 16000 个字符。" }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/web-chat/messages?agentId=plana",
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

    const replyBody = {
      id: "group:10001",
      scope: "user_group",
      replyEnabled: false,
      orchestratorResponseTimeOverrideEnabled: true,
      orchestratorResponseTimeMs: 15_000,
      directorEventsEnabled: true
    };
    expect((await app.inject({
      method: "PUT",
      url: "/api/conversations/reply?agentId=plana",
      payload: replyBody
    })).json()).toEqual({ ok: true, conversation: replyBody });
    expect(setConversationReplyEnabled).toHaveBeenCalledWith(replyBody);

    for (const orchestratorResponseTimeMs of [999, 3_600_001, 1_500.5, "15000"]) {
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/conversations/reply?agentId=plana",
        payload: {
          id: "group:10001",
          scope: "user_group",
          orchestratorResponseTimeOverrideEnabled: true,
          orchestratorResponseTimeMs
        }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          code: "CONVERSATION_ORCHESTRATOR_RESPONSE_TIME_INVALID",
          field: "orchestratorResponseTimeMs"
        }
      });
    }

    expect((await app.inject({
      method: "GET",
      url: "/api/conversations/private%3A171419991/tools?agentId=plana"
    })).json()).toEqual({ conversationId: "private:171419991", disabledTools: ["websearch"] });
    expect(getConversationToolPolicy).toHaveBeenCalledWith("private:171419991");

    const toolsBody = { disabledTools: ["read_file", "native_bash"] };
    expect((await app.inject({
      method: "PUT",
      url: "/api/conversations/private%3A171419991/tools?agentId=plana",
      payload: toolsBody
    })).json()).toEqual({ id: "private:171419991", ...toolsBody });
    expect(setConversationToolPolicy).toHaveBeenCalledWith({ id: "private:171419991", ...toolsBody });

    for (const method of ["GET", "PUT"] as const) {
      const invalid = await app.inject({
        method,
        url: "/api/conversations/not-a-conversation/tools?agentId=plana",
        ...(method === "PUT" ? { payload: { disabledTools: [] } } : {})
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: "CONVERSATION_ID_INVALID" } });
    }

    for (const payload of [
      { disabledTools: ["unknown_tool"] },
      { disabledTools: ["read_file", "read_file"] },
      { disabledTools: "read_file" },
      { disabledTools: [], extra: true }
    ]) {
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/conversations/private%3A171419991/tools?agentId=plana",
        payload
      });
      expect(invalid.statusCode).toBe(400);
    }

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/conversations",
      "/api/conversations/:id/logs",
      "/api/conversations/:id/messages",
      "/api/conversations/:id/stats",
      "/api/conversations/:id/tools",
      "/api/conversations/reply",
      "/api/web-chat/messages"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });

  it("keeps a valid Web Chat turn alive through an asynchronous HTTP handler", async () => {
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
    const response = await app.inject({
      method: "POST",
      url: "/api/web-chat/messages",
      payload: { text: "请确认连接" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
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

  it("cancels Web Chat through the request socket close signal", async () => {
    const started = deferred<AbortSignal>();
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (
        _channel: string,
        _incoming: unknown,
        _delivery: unknown,
        options: { signal: AbortSignal }
      ) => {
        started.resolve(options.signal);
        await new Promise<never>(() => undefined);
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const handlers = new Map<string, (request: never, reply: never) => unknown>();
    const fakeApp = {
      addHook: vi.fn(),
      get: (url: string, _options: unknown, handler: (request: never, reply: never) => unknown) => {
        handlers.set(`GET ${url}`, handler);
      },
      post: (url: string, _options: unknown, handler: (request: never, reply: never) => unknown) => {
        handlers.set(`POST ${url}`, handler);
      },
      put: (url: string, _options: unknown, handler: (request: never, reply: never) => unknown) => {
        handlers.set(`PUT ${url}`, handler);
      }
    } as unknown as ReturnType<typeof Fastify>;
    const onebotGateway = { getStatus: () => ({ connected: false }) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;
    registerConversationRoutes(fakeApp, { runtime, onebotGateway, conversationDirectory });
    const handler = handlers.get("POST /api/web-chat/messages");
    if (!handler) throw new Error("Web Chat POST handler was not registered.");
    const requestRaw = new EventEmitter() as EventEmitter & {
      socket: EventEmitter;
    };
    requestRaw.socket = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      writableFinished: boolean;
    };
    replyRaw.writableEnded = false;
    replyRaw.writableFinished = false;
    const response = Promise.resolve(handler({
      body: { text: "测试断开" },
      query: {},
      raw: requestRaw
    } as never, {
      raw: replyRaw
    } as never));
    const taskSignal = await started.promise;

    requestRaw.socket.emit("close");

    await expect(response).rejects.toMatchObject({
      statusCode: 499,
      code: "WEB_CHAT_REQUEST_ABORTED"
    });
    expect(taskSignal.aborted).toBe(true);
  });

  it("aborts an in-flight Web Chat turn from Fastify preClose", async () => {
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => error instanceof ServiceError
      ? reply.status(error.statusCode).send(error.toJSON())
      : reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: String(error) } }));
    const started = deferred<AbortSignal>();
    const runtime = {
      adminIdentity: () => ({ userId: "171419991", name: "管理员" }),
      incomingCaptureSequence: () => 1,
      recordIncomingMessage: vi.fn(),
      replyToIncoming: vi.fn(async (
        _channel: string,
        _incoming: unknown,
        _delivery: unknown,
        options: { signal: AbortSignal }
      ) => {
        started.resolve(options.signal);
        await new Promise<never>(() => undefined);
      }),
      getConversationMessages: () => ({
        conversationId: "web:admin",
        messages: [],
        hasMore: false,
        memberNames: {}
      })
    } as unknown as SunaRuntime;
    const onebotGateway = { getStatus: () => ({ connected: false }) } as unknown as OneBotGateway;
    const conversationDirectory = {
      enrich: vi.fn(),
      describe: vi.fn((value: unknown) => value)
    } as unknown as ConversationDirectory;
    registerConversationRoutes(app, { runtime, onebotGateway, conversationDirectory });
    const response = app.inject({
      method: "POST",
      url: "/api/web-chat/messages",
      payload: { text: "测试关闭" }
    });
    const taskSignal = await started.promise;

    const closing = app.close();

    await vi.waitFor(() => expect(taskSignal.aborted).toBe(true));
    expect((await response).json()).toEqual({
      error: {
        code: "WEB_CHAT_SHUTTING_DOWN",
        message: "Web Chat 正在关闭，请稍后重试。"
      }
    });
    await closing;
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
      url: "/api/web-chat/messages?agentId=plana",
      payload: { text: "第一条" }
    });
    await firstStarted.promise;
    const second = app.inject({
      method: "POST",
      url: "/api/web-chat/messages?agentId=plana",
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
      completePromptTurn(): Promise<{ kind: "completed"; text: string }>;
      adminIdentity(): { userId: string; name: string };
      incomingCaptureSequence(): number;
      recordIncomingMessage(): void;
      getConversationMessages(): Record<string, unknown>;
    };
    internals.completePromptTurn = async () => {
      await appendRequestLog({
        category: "model.response",
        action: "responses.complete",
        model: "gpt-arona",
        response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } },
        metadata: { conversationId: "web:admin", stage: "reply" }
      });
      return { kind: "completed", text: "测试回复" };
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
        .toContainEqual(expect.objectContaining({ action: "responses.complete", model: "gpt-arona" }));
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
