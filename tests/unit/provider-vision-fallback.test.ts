// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { runtime_completePromptTurn } from "../../src/runtime/lifecycle.js";
import type { ProviderConfig } from "../../src/types.js";

afterEach(() => vi.restoreAllMocks());

describe("provider vision fallback", () => {
  it("replaces images with a helper-model description for text-only providers", async () => {
    const helper = provider("vision", "openai-official");
    vi.spyOn(OpenAIProvider.prototype, "complete").mockResolvedValue("画面中有一只白猫。" as never);
    const captured = vi.fn(async () => ({ kind: "completed" as const, text: "完成" }));
    const main = {
      configuration: () => ({
        ...provider("text", "anthropic-compatible"),
        multimodal: "disabled" as const,
        visionProviderId: helper.id,
        visionModel: "vision-model"
      }),
      completeRequestTurn: captured
    };
    const runtime = {
      config: { providers: { defaultProviderId: "text", items: [helper] } },
      completePrompt: vi.fn()
    };
    const request = {
      messages: [
        { role: "system" as const, content: "system" },
        { role: "user" as const, content: "这是什么？", imageUrls: ["data:image/png;base64,AAAA"] }
      ],
      response_format: { type: "text" }
    };

    await runtime_completePromptTurn.call(runtime as never, main as never, request, {});

    const prepared = captured.mock.calls[0]?.[0];
    expect(prepared.messages[1]).toMatchObject({ imageUrls: [], localImagePaths: [] });
    expect(prepared.messages[1].content).toContain("<image_description>画面中有一只白猫。</image_description>");
    expect(OpenAIProvider.prototype.complete).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({ imageUrls: ["data:image/png;base64,AAAA"] })],
      expect.any(Object)
    );
  });

  it("automatically probes an unknown provider before choosing the vision helper", async () => {
    const helper = provider("vision-auto", "openai-official");
    vi.spyOn(OpenAIProvider.prototype, "complete")
      .mockResolvedValueOnce("BLUE" as never)
      .mockResolvedValueOnce("自动探测后读取到白猫。" as never);
    const captured = vi.fn(async () => ({ kind: "completed" as const, text: "完成" }));
    const main = {
      configuration: () => ({
        ...provider("text-auto", "anthropic-compatible"),
        visionProviderId: helper.id
      }),
      completeRequestTurn: captured
    };
    const runtime = {
      config: { providers: { defaultProviderId: "text-auto", items: [helper] } },
      completePrompt: vi.fn()
    };
    const request = {
      messages: [{ role: "user" as const, content: "这是什么？", imageUrls: ["data:image/png;base64,AAAA"] }],
      response_format: { type: "text" }
    };

    await runtime_completePromptTurn.call(runtime as never, main as never, request, {});

    expect(captured.mock.calls[0]?.[0].messages[0].content).toContain("<image_description>自动探测后读取到白猫。</image_description>");
    expect(OpenAIProvider.prototype.complete).toHaveBeenCalledTimes(2);
  });
});

function provider(id: string, kind: ProviderConfig["kind"]): ProviderConfig {
  return {
    id,
    label: id,
    kind,
    enabled: true,
    model: `${id}-model`,
    imageModel: "gpt-image-2",
    baseUrl: "https://example.com/v1",
    apiKeyEnv: "TEST_KEY",
    temperature: 0.2,
    maxOutputTokens: 1024,
    modelSource: "custom",
    multimodal: "auto"
  };
}
