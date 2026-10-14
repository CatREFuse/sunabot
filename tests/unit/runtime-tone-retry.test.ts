// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { defaultConfig } from "../../src/config.js";
import type { RuntimePromptPort } from "../../src/runtime/runtimeContracts.js";
import { RuntimeTone } from "../../src/runtime/tone.js";

describe("Tone permissive request", () => {
  it("does not inject historical hard-gate retry instructions", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const provider = new OpenAIProvider(config.providers.items[0]!);
    const completePrompt: RuntimePromptPort["completePrompt"] = vi.fn(async (_provider, request) => {
      expect(request.messages.at(-1)).toEqual({
        role: "user",
        content: "原始输入"
      });
      return "<dialog>已修正</dialog>";
    });
    const host: RuntimePromptPort = {
      config,
      getProvider: () => provider,
      renderPromptRequest: vi.fn(async () => ({
        messages: [
          { role: "system", content: "规则" },
          { role: "user", content: "原始输入" }
        ],
        tools: [],
        response_format: { type: "text" }
      })),
      completePrompt
    };

    const result = await new RuntimeTone(host).rewriteForDelivery(
      "原文",
      [],
      {
        hardGateRetry: {
          attempt: 3,
          maxAttempts: 4,
          errors: ["第一处 <exp/> 错误", "第二处 & 媒体错误"]
        }
      }
    );

    expect(result).toEqual({ segmented: true, content: "<dialog>已修正</dialog>" });
    expect(completePrompt).toHaveBeenCalledOnce();
  });
});
