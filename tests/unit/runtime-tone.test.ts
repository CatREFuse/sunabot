// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider, type ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { defaultConfig } from "../../src/config.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { RuntimeTone } from "../../src/runtime/tone.js";
import { AGENT_TOOL_NAMES } from "../../src/types.js";

describe("RuntimeTone", () => {
  it("preserves text without a Provider call while disabled or when the text is blank", async () => {
    const config = defaultConfig();
    const renderPromptRequest = vi.fn();
    const completePrompt = vi.fn();
    const tone = new RuntimeTone({ config, renderPromptRequest, completePrompt } as unknown as SunaRuntime);

    await expect(tone.rewrite("  原文  ")).resolves.toBe("  原文  ");
    config.bot.tone.enabled = true;
    await expect(tone.rewrite(" \n ")).resolves.toBe(" \n ");

    expect(renderPromptRequest).not.toHaveBeenCalled();
    expect(completePrompt).not.toHaveBeenCalled();
  });

  it("uses the selected Provider with independent parameters and strips every tool surface", async () => {
    const config = defaultConfig();
    const selected = { ...config.providers.items[0]!, id: "tone-provider", reasoningEffort: "medium" as const };
    config.bot.tone = {
      enabled: true,
      segmentedReply: false,
      followMainModel: false,
      providerId: selected.id,
      model: "gpt-5.5",
      reasoningEffort: "high",
      temperature: 1.1,
      maxOutputTokens: 3200,
      maxRetries: 4
    };
    const rendered: RenderedPromptRequest = {
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: "raw" }
      ],
      tools: [{
        type: "function",
        function: {
          name: "malicious_tool",
          description: "must be removed",
          parameters: { type: "object" }
        }
      }],
      response_format: { type: "json_schema" },
      extra_request_field: "must be removed"
    };
    const renderPromptRequest = vi.fn(async () => rendered);
    const completePrompt = vi.fn(async () => "  改写结果  ");
    const getProvider = vi.fn(() => new OpenAIProvider(selected));
    const tone = new RuntimeTone({
      config,
      getProvider,
      renderPromptRequest,
      completePrompt
    } as unknown as SunaRuntime);

    await expect(tone.rewrite("原始文本", {
      scope: "private",
      userName: "猫老师",
      logContext: { conversationId: "private:1", runId: "run-1" }
    })).resolves.toBe("改写结果");

    expect(getProvider).toHaveBeenCalledWith(selected.id);
    expect(renderPromptRequest).toHaveBeenCalledWith("conversation.tone-rewrite", expect.objectContaining({
      "bot.name": config.persona.name,
      "user.name": "猫老师",
      "tone.input": "原始文本",
      tone_mode: false
    }));
    const [provider, request, options] = completePrompt.mock.calls[0]! as unknown as [
      OpenAIProvider,
      RenderedPromptRequest,
      ProviderCompleteOptions
    ];
    expect(provider.configuration()).toMatchObject({
      id: selected.id,
      model: "gpt-5.5",
      reasoningEffort: "high",
      temperature: 1.1,
      maxOutputTokens: 3200
    });
    expect(request).toEqual({
      messages: rendered.messages,
      tools: [],
      response_format: { type: "text" }
    });
    expect(options).toMatchObject({
      modelRequestMaxRetries: 4,
      disabledTools: AGENT_TOOL_NAMES,
      logContext: {
        conversationId: "private:1",
        runId: "run-1",
        stage: "tone",
        promptFamily: "conversation.tone-rewrite"
      }
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new RegistryProviderToolExecutor().resolveDefinitions(options, request.tools)).toEqual([]);
  });

  it("uses the current main model configuration while followMainModel is enabled", async () => {
    const config = defaultConfig();
    const main = {
      ...config.providers.items[0]!,
      model: "gpt-5.5",
      reasoningEffort: "high" as const,
      temperature: 0.4,
      maxOutputTokens: 9600
    };
    config.providers.items = [main];
    config.normalReply.maxRetries = 3;
    config.bot.tone = {
      enabled: true,
      segmentedReply: false,
      followMainModel: true,
      providerId: "other-provider",
      model: "tone-model",
      reasoningEffort: "low",
      temperature: 1.1,
      maxOutputTokens: 3200,
      maxRetries: 4
    };
    const getProvider = vi.fn(() => new OpenAIProvider(main));
    const completePrompt = vi.fn(async () => "改写结果");
    const tone = new RuntimeTone({
      config,
      getProvider,
      renderPromptRequest: async () => ({ messages: [{ role: "user", content: "raw" }] }),
      completePrompt
    } as unknown as SunaRuntime);

    await expect(tone.rewrite("原始文本")).resolves.toBe("改写结果");

    expect(getProvider).toHaveBeenCalledWith(undefined);
    const [provider, , options] = completePrompt.mock.calls[0]! as unknown as [
      OpenAIProvider,
      RenderedPromptRequest,
      ProviderCompleteOptions
    ];
    expect(provider.configuration()).toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "high",
      temperature: 0.4,
      maxOutputTokens: 9600
    });
    expect(options.modelRequestMaxRetries).toBe(3);
  });

  it("keeps the original formatted error when Tone rewrites away its details", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    const baseProvider = new OpenAIProvider(config.providers.items[0]!);
    const renderPromptRequest = vi.fn(async () => ({ messages: [{ role: "user" as const, content: "raw" }] }));
    const completePrompt = vi.fn()
      .mockResolvedValueOnce("请老师稍后再试一次。")
      .mockResolvedValueOnce("请老师稍后再试一次。\n异常：Our servers are currently overloaded.");
    const tone = new RuntimeTone({
      config,
      getProvider: () => baseProvider,
      renderPromptRequest,
      completePrompt
    } as unknown as SunaRuntime);

    await expect(tone.rewrite("异常：Our servers are currently overloaded."))
      .resolves.toBe("请老师稍后再试一次。\n异常：Our servers are currently overloaded.");
    await expect(tone.rewrite("异常：Our servers are currently overloaded."))
      .resolves.toBe("请老师稍后再试一次。\n异常：Our servers are currently overloaded.");
    expect(renderPromptRequest).toHaveBeenCalledWith(
      "conversation.tone-rewrite",
      expect.objectContaining({
        "tone.output_contract": expect.stringContaining("错误原文")
      })
    );
  });

  it("keeps the original formatted error in segmented XML without duplicating it", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const baseProvider = new OpenAIProvider(config.providers.items[0]!);
    const original = '异常：Provider returned <400> & "bad".';
    const encoded = "异常：Provider returned &lt;400&gt; &amp; &quot;bad&quot;.";
    const completePrompt = vi.fn()
      .mockResolvedValueOnce("<dialog>请老师稍后再试。</dialog>")
      .mockResolvedValueOnce(`<dialog>请老师稍后再试。\n${encoded}</dialog>`);
    const tone = new RuntimeTone({
      config,
      getProvider: () => baseProvider,
      renderPromptRequest: async () => ({ messages: [{ role: "user", content: "raw" }] }),
      completePrompt
    } as unknown as SunaRuntime);

    await expect(tone.rewriteForDelivery(original, []))
      .resolves.toEqual({
        segmented: true,
        content: `<dialog>请老师稍后再试。</dialog><dialog>${encoded}</dialog>`
      });
    await expect(tone.rewriteForDelivery(original, []))
      .resolves.toEqual({
        segmented: true,
        content: `<dialog>请老师稍后再试。\n${encoded}</dialog>`
      });
  });

  it("requests the XML contract and exposes only registered media handles for segmented delivery", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const baseProvider = new OpenAIProvider(config.providers.items[0]!);
    const renderPromptRequest = vi.fn(async () => ({ messages: [{ role: "user" as const, content: "raw" }] }));
    const completePrompt = vi.fn(async () => [
      '<dialogc replay="msg_id">老师！</dialogc>',
      '<img src="asset:image:0"/>'
    ].join(""));
    const tone = new RuntimeTone({
      config,
      getProvider: () => baseProvider,
      renderPromptRequest,
      completePrompt
    } as unknown as SunaRuntime);

    const rawXmlDraft = "<dialog>命令：<br/>npm run check</dialog>";
    await expect(tone.rewriteForDelivery(rawXmlDraft, [
      { kind: "image", src: "asset:image:0" }
    ], {}, ["[/开心]"])).resolves.toEqual({
      segmented: true,
      content: '<dialogc replay="msg_id">老师！</dialogc><img src="asset:image:0"/>'
    });
    expect(renderPromptRequest).toHaveBeenCalledWith(
      "conversation.tone-rewrite",
      expect.objectContaining({
        "tone.input": rawXmlDraft,
        tone_mode: true,
        "tone.available_assets": '[{"kind":"image","src":"asset:image:0"}]',
        "tone.output_contract": expect.stringContaining('["[/开心]"]')
      })
    );
  });

  it("rejects untrusted media handles before rendering the segmented prompt", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    config.bot.tone.segmentedReply = true;
    const renderPromptRequest = vi.fn();
    const tone = new RuntimeTone({ config, renderPromptRequest } as unknown as SunaRuntime);

    await expect(tone.rewriteForDelivery("原文", [
      { kind: "file", src: "https://example.com/private.txt" }
    ])).rejects.toMatchObject({ code: "TONE_ASSET_HANDLE_INVALID" });
    expect(renderPromptRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the enabled node returns no sendable text", async () => {
    const config = defaultConfig();
    config.bot.tone.enabled = true;
    const baseProvider = new OpenAIProvider(config.providers.items[0]!);
    const tone = new RuntimeTone({
      config,
      getProvider: () => baseProvider,
      renderPromptRequest: async () => ({
        messages: [{ role: "user", content: "raw" }],
        response_format: { type: "text" }
      }),
      completePrompt: async () => " \n "
    } as unknown as SunaRuntime);

    await expect(tone.rewrite("原文")).rejects.toThrow("Tone 节点没有返回可发送内容");
  });
});
