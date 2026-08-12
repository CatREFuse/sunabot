// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentRoutes } from "../../apps/api/plugins/agentRoutes.js";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import type { AgentSoulService } from "../../src/admin/agentSoul.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Agent soul API", () => {
  it("streams export and binds preview and import to the route Agent", async () => {
    const document = Buffer.from('{"schema":"sunabot.soul","version":1,"source":{"agentId":"arona","name":"阿罗娜"},"files":[]}\n');
    const soulService = {
      export: vi.fn(async () => ({ fileName: "arona.sunabot-soul.json", bytes: document, packageSha256: "a".repeat(64) })),
      preview: vi.fn(async (agentId: string) => ({
        schema: "sunabot.soul",
        version: 1,
        source: { agentId: "arona", name: "阿罗娜" },
        targetAgentId: agentId,
        packageSha256: "a".repeat(64),
        targetRevision: "b".repeat(64),
        files: []
      })),
      apply: vi.fn(async () => ({ ok: true, imported: 9, targetRevision: "c".repeat(64) }))
    } as unknown as AgentSoulService;
    const app = Fastify();
    apps.push(app);
    registerAgentRoutes(app, {} as AgentRegistry, { soulService });

    const exported = await app.inject({ method: "GET", url: "/api/agents/arona/soul/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["cache-control"]).toBe("no-store");
    expect(exported.headers["content-disposition"]).toBe('attachment; filename="arona.sunabot-soul.json"');
    expect(exported.body).toBe(document.toString("utf8"));

    const upload = { fileName: "arona.sunabot-soul.json", dataBase64: document.toString("base64") };
    const preview = await app.inject({ method: "POST", url: "/api/agents/plana/soul/preview", payload: upload });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.json()).toMatchObject({ targetAgentId: "plana" });
    expect(soulService.preview).toHaveBeenCalledWith("plana", upload);

    const request = { ...upload, packageSha256: "a".repeat(64), targetRevision: "b".repeat(64) };
    const imported = await app.inject({ method: "POST", url: "/api/agents/plana/soul/import", payload: request });
    expect(imported.statusCode).toBe(200);
    expect(imported.headers["cache-control"]).toBe("no-store");
    expect(imported.json()).toMatchObject({ ok: true, imported: 9 });
    expect(soulService.apply).toHaveBeenCalledWith("plana", request);
  });
});
