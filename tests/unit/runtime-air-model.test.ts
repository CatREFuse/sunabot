// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { RuntimeAir } from "../../src/runtime/air.js";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { readAirKnowledge } from "../../services/air/public.js";

vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("AIR model selection", () => {
  it.each([undefined, "", "air-model"])("persists AIR with Agent model override %s instead of the rejected shared model", async (airModel) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-air-model-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.agentWorkspace = root;
    config.bot.replyModel = "reply-model";
    config.bot.airModel = airModel;
    const base = { ...config.providers.items[0]!, model: "gpt-5.5" };
    const getProviderForModel = vi.fn((model: string) => new OpenAIProvider({ ...base, model }));
    const completePrompt = vi.fn(async (provider: OpenAIProvider) => {
      if (provider.configuration().model === "gpt-5.5") throw new Error("HTTP 400: unsupported model");
      return "# 互动约定\n\n当前私聊称呼用户为林老师。";
    });
    const host = {
      config, conversationRecords: new Map(),
      getProvider: () => new OpenAIProvider(base), getProviderForModel,
      renderPromptRequest: vi.fn(async () => ({ messages: [] })), completePrompt,
      persona: undefined
    };
    const runtime = new RuntimeAir(host as never);
    const port = runtime.toolPort({ scope: "private", userId: 10001 } as never, []);
    await expect(port.execute({ insight: "仅当前私聊称呼林老师" })).resolves.toMatchObject({ ok: true, updated: true });
    expect(getProviderForModel).toHaveBeenLastCalledWith(airModel || "reply-model", airModel ? undefined : config.bot.replyReasoningEffort);
    expect((await readAirKnowledge(config)).content).toContain("林老师");
    expect(host.persona).toBeDefined();
    config.bot.replyModel = "next-reply-model";
    await port.execute({ insight: "确认同一约定" });
    expect(getProviderForModel).toHaveBeenLastCalledWith(airModel || "next-reply-model", airModel ? undefined : config.bot.replyReasoningEffort);
    completePrompt.mockRejectedValueOnce(new Error("Provider unavailable"));
    const before = await readAirKnowledge(config);
    await expect(port.execute({ insight: "不应丢失旧约定" })).resolves.toMatchObject({ ok: false, code: "READ_AIR_FAILED" });
    expect(await readAirKnowledge(config)).toEqual(before);
  });
});
