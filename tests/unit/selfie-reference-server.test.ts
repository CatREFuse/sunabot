// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, createApp } from "../../apps/api/server.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
let previousAdminToken: string | undefined;
const ADMIN_HEADERS = {
  host: "127.0.0.1",
  "x-forwarded-for": "127.0.0.1",
  authorization: "Bearer selfie-admin-token"
};

beforeEach(async () => {
  previousAdminToken = process.env.SUNABOT_ADMIN_TOKEN;
  process.env.SUNABOT_ADMIN_TOKEN = "selfie-admin-token";
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-server-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(authorized.json()).toEqual({ images: [], maxImages: 9 });
    await app.close();
  });

  it("keeps default storage injected and manages disabled or stopped registered Agents without runtime", async () => {
    const config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const built = await buildApp({
      config,
      initializeRuntime: false,
      onebotListener: false,
      agentRegistry: {
        workspaceRoot: path.dirname(config.persona.agentWorkspace),
        allowUnmarkedMigration: true
      }
    });
    const originalConfig = built.agentRegistry.config.bind(built.agentRegistry);
    const registryConfig = vi.spyOn(built.agentRegistry, "config").mockImplementation(async (
      agentId,
      sharedConfig = config
    ) => {
      const resolved = await originalConfig(agentId, sharedConfig);
      if (agentId === config.persona.defaultAgentId) return resolved;
      return {
        ...resolved,
        persona: {
          ...resolved.persona,
          agentWorkspace: path.join(root, "isolated-agent-workspaces", agentId)
        }
      };
    });

    try {
      const callsBeforeDefaultGet = registryConfig.mock.calls.length;
      const defaultList = await built.app.inject({
        method: "GET",
        url: "/api/selfie-references",
        headers: ADMIN_HEADERS
      });
      expect(defaultList.statusCode).toBe(200);
      expect(defaultList.json()).toEqual({ images: [], maxImages: 9 });
      expect(registryConfig.mock.calls).toHaveLength(callsBeforeDefaultGet);
      await expect(fs.lstat(path.join(config.persona.agentWorkspace, "selfie")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const disabled = await built.agentRegistry.create({ id: "disabled-selfie", name: "Disabled Selfie" });
      await built.agentRegistry.update(disabled.id, { enabled: false });
      expect(built.agentRuntimeManager.get(disabled.id)).toBeUndefined();

      const stopped = await built.agentRegistry.create({ id: "stopped-selfie", name: "Stopped Selfie" });
      await built.agentRuntimeManager.start(stopped.id);
      await built.agentRuntimeManager.stop(stopped.id);
      expect(built.agentRuntimeManager.get(stopped.id)).toBeUndefined();

      for (const [index, agentId] of [disabled.id, stopped.id].entries()) {
        const list = await built.app.inject({
          method: "GET",
          url: `/api/selfie-references?agentId=${encodeURIComponent(agentId)}`,
          headers: ADMIN_HEADERS
        });
        expect(list.statusCode).toBe(200);
        expect(list.json()).toEqual({ images: [], maxImages: 9 });

        const bytes = await sharp({
          create: {
            width: 24,
            height: 24,
            channels: 3,
            background: index === 0 ? "#d8edff" : "#fff0f6"
          }
        }).png().toBuffer();
        const uploaded = await built.app.inject({
          method: "POST",
          url: `/api/selfie-references?agentId=${encodeURIComponent(agentId)}`,
          headers: ADMIN_HEADERS,
          payload: {
            fileName: `${agentId}.png`,
            dataBase64: bytes.toString("base64"),
            note: index === 0 ? "泳装" : "女仆装"
          }
        });
        expect(uploaded.statusCode).toBe(201);
        const reference = uploaded.json().images[0];

        const patched = await built.app.inject({
          method: "PATCH",
          url: `/api/selfie-references/${reference.id}?agentId=${encodeURIComponent(agentId)}`,
          headers: ADMIN_HEADERS,
          payload: { note: "更新备注" }
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json().images[0]).toMatchObject({ id: reference.id, note: "更新备注" });

        const removed = await built.app.inject({
          method: "DELETE",
          url: `/api/selfie-references/${reference.id}?agentId=${encodeURIComponent(agentId)}`,
          headers: ADMIN_HEADERS
        });
        expect(removed.statusCode).toBe(204);
        const finalList = await built.app.inject({
          method: "GET",
          url: `/api/selfie-references?agentId=${encodeURIComponent(agentId)}`,
          headers: ADMIN_HEADERS
        });
        expect(finalList.statusCode).toBe(200);
        expect(finalList.json()).toEqual({ images: [], maxImages: 9 });
      }
    } finally {
      await built.app.close();
    }
  });
});
