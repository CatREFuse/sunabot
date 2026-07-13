// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/server.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
let previousAdminToken: string | undefined;

beforeEach(async () => {
  previousAdminToken = process.env.SUNABOT_ADMIN_TOKEN;
  process.env.SUNABOT_ADMIN_TOKEN = "selfie-admin-token";
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-server-"));
});

afterEach(async () => {
  if (previousAdminToken == null) delete process.env.SUNABOT_ADMIN_TOKEN;
  else process.env.SUNABOT_ADMIN_TOKEN = previousAdminToken;
  await fs.rm(root, { recursive: true, force: true });
});

describe("selfie reference server registration", () => {
  it("protects the registered API and exposes the WebUI envelope", async () => {
    const config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const app = await createApp({
      config,
      initializeRuntime: false,
      onebotListener: false,
      agentRegistry: {
        workspaceRoot: path.dirname(config.persona.agentWorkspace),
        allowUnmarkedMigration: true
      }
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/selfie-references",
      headers: { host: "127.0.0.1", "x-forwarded-for": "127.0.0.1" }
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/api/selfie-references",
      headers: {
        host: "127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
        authorization: "Bearer selfie-admin-token"
      }
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ images: [], maxImages: 3 });
    await app.close();
  });
});
