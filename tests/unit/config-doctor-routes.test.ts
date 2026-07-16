// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConfigDoctorRoutes } from "../../apps/api/plugins/configDoctorRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("config doctor API plugin", () => {
  it("registers schemas and keeps patch data on the server", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(`${route.method}:${route.url}`, route.schema ?? {}));
    const scan = vi.fn(async () => ({ ...report("healthy"), internalCandidate: { secret: true } }));
    const propose = vi.fn(async () => ({ ...report("repairable"), internalOperations: [{ op: "replace" }] }));
    const apply = vi.fn(async () => ({
      ok: true as const,
      repairId: "repair",
      repairedAt: "2026-07-16T10:00:00.000Z",
      sourceRevision: "next-source",
      backupPath: "backups/config-doctor/repair/before.json",
      restartRequired: false as const,
      appliedChanges: 1,
      internalCandidate: { secret: true }
    }));
    registerConfigDoctorRoutes(app, { scan, propose, apply });

    const scanResponse = await app.inject({ method: "GET", url: "/api/config-doctor/scan" });
    expect(scanResponse.statusCode).toBe(200);
    expect(scanResponse.json()).not.toHaveProperty("internalCandidate");
    const proposeResponse = await app.inject({
      method: "POST",
      url: "/api/config-doctor/propose",
      payload: { sourceRevision: "source" }
    });
    expect(proposeResponse.statusCode).toBe(200);
    expect(proposeResponse.json()).not.toHaveProperty("internalOperations");
    const applyResponse = await app.inject({
      method: "POST",
      url: "/api/config-doctor/apply",
      payload: { proposalId: "proposal", sourceRevision: "source" }
    });
    expect(applyResponse.statusCode).toBe(200);
    expect(applyResponse.json()).not.toHaveProperty("internalCandidate");
    const injectedPatch = await app.inject({
      method: "POST",
      url: "/api/config-doctor/apply",
      payload: { proposalId: "proposal", sourceRevision: "source", candidate: { secret: true } }
    });
    expect(injectedPatch.statusCode).toBe(200);

    expect(propose).toHaveBeenCalledWith("source");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, { proposalId: "proposal", sourceRevision: "source" });
    expect(apply).toHaveBeenNthCalledWith(2, { proposalId: "proposal", sourceRevision: "source" });
    expect([...routeSchemas.keys()].sort()).toEqual([
      "GET:/api/config-doctor/scan",
      "HEAD:/api/config-doctor/scan",
      "POST:/api/config-doctor/apply",
      "POST:/api/config-doctor/propose"
    ]);
    for (const schema of routeSchemas.values()) expect(schema.response).toBeDefined();
  });
});

function report(status: "healthy" | "repairable") {
  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-07-16T10:00:00.000Z",
    status,
    sourceRevision: "source",
    issues: [],
    ai: { available: false }
  };
}
