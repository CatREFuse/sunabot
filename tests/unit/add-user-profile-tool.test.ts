// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import { readUserProfileForUser } from "../../services/memory/public.js";
import {
  addUserProfileTool,
  runAddUserProfile
} from "../../services/tools/addUserProfileTool.js";
import { RuntimeUserProfile } from "../../src/runtime/userProfile.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("add_user_profile tool", () => {
  let root = "";

  afterEach(async () => {
    closeApplicationDataStores();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("requires one complete aggregate-profile decision for the current speaker", () => {
    expect(addUserProfileTool).toMatchObject({
      strict: true,
      parameters: {
        additionalProperties: false,
        required: ["action", "profile", "addressNames"]
      }
    });
    expect(addUserProfileTool.description).toContain("current speaker");
    expect(addUserProfileTool.description).toContain("complete updated profile");
    expect(addUserProfileTool.description).toContain("complete ordered list");
  });

  it("trims and deduplicates a record decision before calling the host port", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runAddUserProfile({
      action: "record",
      profile: "  老师长期关注记忆系统。  ",
      addressNames: [" 老师 ", "老师", "Tan"]
    }, { execute })).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({
      action: "record",
      profile: "老师长期关注记忆系统。",
      addressNames: ["老师", "Tan"]
    }, undefined);
  });

  it.each([
    { action: "skip", profile: "", addressNames: null },
    { action: "record", profile: null, addressNames: [] },
    { action: "record", profile: "有效", addressNames: null },
    { action: "record", profile: "有效", addressNames: [""] },
    { action: "record", profile: "有效", addressNames: [], userId: "forged" }
  ])("rejects invalid or host-owned arguments: %#", async (input) => {
    const execute = vi.fn();
    await expect(runAddUserProfile(input, { execute })).resolves.toMatchObject({
      ok: false,
      code: "ADD_USER_PROFILE_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("replaces only the bound current speaker profile and preserves ordered address names", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-user-profile-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeUserProfile({ config });
    const port = runtime.toolPort(incoming(), "event-profile-1");

    await expect(port.execute({
      action: "record",
      profile: "老师长期关注记忆系统，也偏好直接展示真实 gap。",
      addressNames: ["老师", "Tan"]
    })).resolves.toMatchObject({ ok: true, action: "record", userId: "171419991" });

    expect(await readUserProfileForUser(config, "171419991")).toMatchObject({
      text: "老师长期关注记忆系统，也偏好直接展示真实 gap。",
      addressNames: ["老师", "Tan"]
    });
    expect(port.decisionResolved?.()).toBe(true);
    expect(applicationDataStore(config).readRequestLogs({
      query: "user_profile.tool_decision",
      limit: 10
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "memory.operation",
        action: "user_profile.tool_decision",
        response: expect.objectContaining({ outcome: "recorded" })
      })
    ]));
  });
});

function incoming(): ParsedIncomingMessage {
  return {
    accountId: "primary",
    scope: "private",
    userId: 171419991,
    sender: { nickname: "Tan" },
    text: "我长期关注记忆系统，以后优先叫我老师。",
    attachments: [],
    images: [],
    mentionedSelf: false,
    messageId: 1001
  } as ParsedIncomingMessage;
}
