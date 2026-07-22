// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";
import { defaultConfig } from "../../src/config.js";
import { providerWorkbenchFilesForIncoming } from "../../src/runtime/workbenchFiles.js";
import { testTempRoot } from "./test-temp-root.js";

const TEST_DATA_ROOT = testTempRoot("runtime-workbench-files");
const roots: string[] = [];

beforeAll(async () => {
  await fs.mkdir(TEST_DATA_ROOT, { recursive: true });
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workbench file runtime authorization", () => {
  it("grants capability to a real normalized OneBot administrator private message", async () => {
    const { config, agentWorkspace } = await fixtureConfig();
    const incoming = normalizedPrivate(config.bot.adminQq, config.persona.defaultAgentId);
    expect(incoming.transport).toBeUndefined();

    const port = providerWorkbenchFilesForIncoming(config, incoming, undefined);
    expect(port).toBeDefined();
    await expect(port!.write({ path: "authorized.txt", content: "ok", overwrite: false }))
      .resolves.toMatchObject({ ok: true });
    await expect(port!.read({ path: "authorized.txt" }))
      .resolves.toMatchObject({ ok: true, content: "ok" });
    await expect(fs.readFile(path.join(agentWorkspace, "workbench", "authorized.txt"), "utf8"))
      .resolves.toBe("ok");
  });

  it("fails closed for an empty-string prompt override before creating workbench", async () => {
    const { config, agentWorkspace } = await fixtureConfig();
    const incoming = normalizedPrivate(config.bot.adminQq, config.persona.defaultAgentId);

    expect(providerWorkbenchFilesForIncoming(config, incoming, "")).toBeUndefined();
    await expect(fs.lstat(path.join(agentWorkspace, "workbench"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["ordinary private user", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, userId: 171419992 })],
    ["group message", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, scope: "user_group" as const, groupId: 778899 })],
    ["Web Chat", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, transport: "web" as const })],
    ["missing account", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, accountId: undefined })],
    ["missing Agent", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, agentId: undefined })],
    ["other Agent", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, agentId: "agent-b" })],
    ["missing message id", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, messageId: undefined })],
    ["missing self id", (incoming: ReturnType<typeof normalizedPrivate>) => ({ ...incoming, selfId: undefined })]
  ])("does not expose capability for $0", async (_label, mutate) => {
    const { config, agentWorkspace } = await fixtureConfig();
    const incoming = mutate(normalizedPrivate(config.bot.adminQq, config.persona.defaultAgentId));

    expect(providerWorkbenchFilesForIncoming(config, incoming, undefined)).toBeUndefined();
    await expect(fs.lstat(path.join(agentWorkspace, "workbench"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a normalized configured admin QQ", async () => {
    const { config, agentWorkspace } = await fixtureConfig();
    const incoming = normalizedPrivate("171419991", config.persona.defaultAgentId);
    config.bot.adminQq = "";
    expect(providerWorkbenchFilesForIncoming(config, incoming, undefined)).toBeUndefined();
    config.bot.adminQq = "invalid-admin";
    expect(providerWorkbenchFilesForIncoming(config, incoming, undefined)).toBeUndefined();
    await expect(fs.lstat(path.join(agentWorkspace, "workbench"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixtureConfig() {
  const config = defaultConfig();
  const agentWorkspace = await fs.mkdtemp(path.join(TEST_DATA_ROOT, "runtime-agent-"));
  roots.push(agentWorkspace);
  config.persona.defaultAgentId = "plana";
  config.persona.agentWorkspace = agentWorkspace;
  config.bot.adminQq = " 171419991 ";
  return { config, agentWorkspace };
}

function normalizedPrivate(adminQq: string, agentId: string) {
  const event: OneBotEvent = {
    post_type: "message",
    message_type: "private",
    message_id: 991,
    user_id: Number(adminQq.trim()),
    self_id: 4004,
    time: 1_788_000_000,
    sender: { nickname: "admin" },
    message: "读取工作文件"
  };
  return {
    ...parseOneBotInboundMessage(event)!,
    agentId,
    accountId: "primary"
  };
}
