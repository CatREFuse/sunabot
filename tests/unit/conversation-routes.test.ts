// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConversationRoutes } from "../../apps/api/plugins/conversationRoutes.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import type { SunaRuntime } from "../../src/runtime.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("conversation API plugin", () => {
  it("registers schemas and preserves conversation delegation", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));

    const records = [{ id: "private:171419991", title: "管理员" }];
    const hydrateConversationRecords = vi.fn(async () => undefined);
    const hydrateConversationIdentities = vi.fn(async () => undefined);
    const getConversationMessages = vi.fn(() => ({ messages: [{ role: "user", content: "hello" }] }));
    const setConversationReplyEnabled = vi.fn((body: unknown) => body);
    const runtime = {
      getConversationRecords: vi.fn(() => records),
      hydrateConversationRecords,
      hydrateConversationIdentities,
      getConversationMessages,
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
      "/api/conversations/reply"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
