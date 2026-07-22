// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerReleaseRoutes } from "../../apps/api/plugins/releaseRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("release API plugin", () => {
  it("returns the current version and public changelog through a closed schema", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(`${route.method}:${route.url}`, route.schema ?? {}));
    registerReleaseRoutes(app);

    const response = await app.inject({ method: "GET", url: "/api/releases" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      currentVersion: "0.1.0",
      releases: [{ version: "0.1.0", releasedAt: "2026-07-22", title: "首次发布" }]
    });
    expect([...routeSchemas.keys()].sort()).toEqual([
      "GET:/api/releases",
      "HEAD:/api/releases"
    ]);
    for (const schema of routeSchemas.values()) expect(schema.response).toBeDefined();
  });
});
