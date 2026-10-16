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

  it("offers optional profile updates without a tool-order prerequisite", () => {
    expect(addUserProfileTool).toMatchObject({
      strict: false,
      parameters: {
        additionalProperties: true,
        required: ["action"]
      }
    });
    expect(addUserProfileTool.description).toContain("current speaker");
    expect(addUserProfileTool.description).toContain("complete updated profile");
    expect(addUserProfileTool.description).toContain("complete ordered list");
    expect(addUserProfileTool.description).toContain("first mention");
    expect(addUserProfileTool.description).toContain("no required tool order");
    expect(addUserProfileTool.description).not.toContain("exactly one");
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

  it("accepts missing content, large content, and extra fields without changing host identity", async () => {
    const execute = vi.fn(async()=>({ok:true}));
    const profile = "记".repeat(5000);
    const addressNames = Array.from({length:20},(_,i)=>"称".repeat(80)+i);
    await expect(runAddUserProfile({action:"record",profile,addressNames,userId:"forged"},{execute})).resolves.toEqual({ok:true});
    expect(execute).toHaveBeenCalledWith({action:"record",profile,addressNames},undefined);
    await expect(runAddUserProfile({action:"skip"},{execute})).resolves.toEqual({ok:true});
    await expect(runAddUserProfile({action:"record"},{execute})).resolves.toEqual({ok:true});
  });

  it("preserves the old profile and names when model fields are absent", async () => {
    root=await fs.mkdtemp(path.join(os.tmpdir(),"sunabot-profile-partial-"));
    const config=createAdminTestConfig(path.join(root,"agent-a"));
    await fs.mkdir(config.persona.agentWorkspace,{recursive:true});
    const runtime=new RuntimeUserProfile({config});
    await runtime.toolPort(incoming()).execute({action:"record",profile:"existing profile",addressNames:["name"]});
    await expect(runtime.toolPort(incoming()).execute({action:"record"})).resolves.toMatchObject({ok:true,recorded:false});
    expect(await readUserProfileForUser(config,"171419991")).toMatchObject({text:"existing profile",addressNames:["name"]});
    await runtime.toolPort(incoming()).execute({action:"record",profile:"updated profile"});
    expect(await readUserProfileForUser(config,"171419991")).toMatchObject({text:"updated profile",addressNames:["name"]});
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

  it("records an omitted decision as unchanged while preserving unresolved tool failures", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-profile-audit-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeUserProfile({ config });
    runtime.recordToolDecision(incoming(), []);
    runtime.recordToolDecision(incoming(), ["add_user_profile"]);
    const logs = applicationDataStore(config).readRequestLogs({ query: "user_profile.tool_decision", limit: 10 });
    expect(logs.map((log) => log.response)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "unchanged", reasonCode: "model_not_invoked", changedCount: 0 }),
      expect.objectContaining({ outcome: "rejected", reasonCode: "decision_unresolved", changedCount: 0 })
    ]));
  });

  it("updates only names and leaves the saved profile unchanged on skip", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-profile-names-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeUserProfile({ config });
    await runAddUserProfile({ action: "record", profile: "偏好简洁回复。", addressNames: ["小星"] }, runtime.toolPort(incoming()));
    await runAddUserProfile({ action: "record", addressNames: ["星野", "小星"] }, runtime.toolPort(incoming()));
    const saved = await readUserProfileForUser(config, "171419991");
    expect(saved).toMatchObject({ text: "偏好简洁回复。", addressNames: ["星野", "小星"] });
    await runAddUserProfile({ action: "skip" }, runtime.toolPort(incoming()));
    expect(await readUserProfileForUser(config, "171419991")).toEqual(saved);
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
