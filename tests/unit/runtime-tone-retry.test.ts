// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { defaultConfig } from "../../src/config.js";
import type { RuntimePromptPort } from "../../src/runtime/runtimeContracts.js";
import { RuntimeTone } from "../../src/runtime/tone.js";

describe("Tone hard-gate retry request", () => {
  it("appends the cumulative retry state and escaped errors as the final request message", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const provider = new OpenAIProvider(config.providers.items[0]!);
    const completePrompt: RuntimePromptPort["completePrompt"] = vi.fn(async (_provider, request) => {
      expect(request.messages.at(-1)).toEqual({
        role: "developer",
        content: [
          '<tone_retry_state attempt="3" max_attempts="4">',
          "上一轮 Tone 输出未通过宿主硬编码门禁。以下错误按发生顺序累计：",
          "1. 第一处 &lt;exp/&gt; 错误",
          "2. 第二处 &amp; 媒体错误",
          "请根据全部累计错误重新生成完整结果，严格遵守 tone_output_contract，不要重复任何已经指出的错误。",
          "</tone_retry_state>"
        ].join("\n")
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
