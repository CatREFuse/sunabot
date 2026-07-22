// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AIR_KNOWLEDGE } from "../../services/air/public.js";
import { defaultConfig } from "../../src/config.js";
import { RuntimeAir } from "../../src/runtime/air.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { ParsedIncomingMessage } from "../../src/types.js";

vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog: vi.fn(async () => undefined) }));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("RuntimeAir", () => {
  it("passes old knowledge, recent chat and character insight to the editable prompt before replacing AIR.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-air-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.agentWorkspace = root;
    await fs.writeFile(path.join(root, "AIR.md"), DEFAULT_AIR_KNOWLEDGE, "utf8");
    const variables: Record<string, unknown> = {};
    const updated = DEFAULT_AIR_KNOWLEDGE.replace(
      "当前没有已确认的会话专属条目。",
      "范围 private:42：用户明确表示讨厌剧透，后续避免未经询问讨论结局。"
    );
    const incoming: ParsedIncomingMessage = {
      schemaVersion: 1,
      transport: "onebot",
      accountId: "primary",
      scope: "private",
      messageId: 7,
      time: "2026-07-20T12:00:00.000Z",
      userId: 42,
      sender: { id: "42", displayName: "小猫" },
      text: "我讨厌剧透",
      media: [],
      attachments: [],
      replyMessageIds: [],
      quoteReferences: [],
      mentionedSelf: true
    };
    const host = {
      config,
      persona: undefined,
      conversationRecords: new Map([[
        "private:42",
        { id: "private:42", scope: "private", title: "小猫", messages: [] }
      ]]),
      renderPromptRequest: vi.fn(async (_id: string, input: Record<string, unknown>) => {
        Object.assign(variables, input);
        return { messages: [], tools: [], response_format: { type: "text" } };
      }),
      completePrompt: vi.fn(async () => updated),
      getProvider: vi.fn(() => ({}))
    } as unknown as SunaRuntime;

    const result = await new RuntimeAir(host).toolPort(incoming, [
      { role: "assistant", content: "最近在聊一部电影。" },
      { role: "user", content: "我讨厌剧透" }
    ]).execute({ insight: "这是明确边界，只适用于当前私聊。" });

    expect(result).toMatchObject({ ok: true, updated: true });
    expect(variables["air.knowledge"]).toContain("当前中文互联网公共语境");
    expect(variables["air.insight"]).toBe("这是明确边界，只适用于当前私聊。");
    expect(variables["air.conversation"]).toMatchObject({
      conversation: { id: "private:42", scope: "private", title: "小猫" },
      messages: [
        { role: "assistant", content: "最近在聊一部电影。" },
        { role: "user", content: "我讨厌剧透" }
      ]
    });
    expect(await fs.readFile(path.join(root, "AIR.md"), "utf8")).toContain("讨厌剧透");
  });
});
