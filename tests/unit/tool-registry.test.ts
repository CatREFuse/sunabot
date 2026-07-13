import { describe, expect, it } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { OpenAIToolDefinition } from "../../services/agent/promptSystem.js";
import { AGENT_TOOL_NAMES } from "../../src/types.js";
import {
  listToolMetadata,
  providerToolExecutionMode,
  resolveProviderToolDefinitions
} from "../../services/tools/toolRegistry.js";

describe("ToolRegistry", () => {
  it("uses one canonical name for metadata and the model definition", () => {
    const metadata = listToolMetadata();
    const definitions = resolveProviderToolDefinitions({
      bash: { enabled: true, workspaceOnly: true, blockedKeywords: [] }
    });
    const names = definitions.map((definition) => String(definition.name));

    expect(metadata.some((tool) => tool.name === "workspace_bash")).toBe(true);
    expect(metadata.some((tool) => tool.name === "bash.run")).toBe(false);
    expect(metadata.map((tool) => tool.name)).toEqual(AGENT_TOOL_NAMES);
    expect(metadata.some((tool) => tool.name === "system.time")).toBe(false);
    expect(metadata.some((tool) => tool.name === "onebot.send_message")).toBe(false);
    expect(metadata.some((tool) => tool.name === "provider.test")).toBe(false);
    expect(names).toEqual(["workspace_bash"]);
    expect(providerToolExecutionMode("workspace_bash")).toBe("inline");
  });

  it("does not expose disabled provider tools", () => {
    expect(resolveProviderToolDefinitions({})).toEqual([]);
  });

  it("exposes assistant_text only when the runtime can deliver intermediate text", () => {
    expect(resolveProviderToolDefinitions({ onAssistantText: () => undefined }).map((tool) => tool.name))
      .toEqual(["assistant_text"]);
    expect(providerToolExecutionMode("assistant_text")).toBe("inline");
  });

  it("injects no_reply into legacy reply prompts and accepts it only as a terminal solo call", () => {
    const used: string[] = [];
    const options = {
      allowNoReply: true,
      onToolCall: (name: string) => used.push(name)
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const call = {
      type: "function_call" as const,
      name: "no_reply",
      call_id: "call-no-reply",
      arguments: "{}"
    };

    expect(definitions).toEqual([
      expect.objectContaining({
        name: "no_reply",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: []
        }
      })
    ]);
    expect(listToolMetadata(options, []).find((tool) => tool.name === "no_reply")).toMatchObject({
      promptEnabled: true,
      enabled: true,
      available: true,
      effectiveEnabled: true,
      execution: "inline"
    });
    expect(executor.noReplyTurn([call], options, definitions)).toEqual({ kind: "no_reply" });
    expect(used).toEqual(["no_reply"]);
  });

  it("rejects no_reply mixed with another tool without executing either call", async () => {
    const delivered: string[] = [];
    const used: string[] = [];
    const options = {
      allowNoReply: true,
      onAssistantText: (text: string) => { delivered.push(text); },
      onToolCall: (name: string) => { used.push(name); }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("assistant_text")]);
    const calls = [{
      type: "function_call" as const,
      name: "no_reply",
      call_id: "call-no-reply-mixed",
      arguments: "{}"
    }, {
      type: "function_call" as const,
      name: "assistant_text",
      call_id: "call-assistant-text-mixed",
      arguments: JSON.stringify({ text: "不应发送" })
    }];

    expect(executor.noReplyTurn(calls, options, definitions)).toBeNull();
    const outputs = await executor.execute(calls, options, definitions);
    expect(outputs.map((output) => JSON.parse(String(output.output)))).toEqual([
      { ok: false, error: "no_reply must be called alone before any other tool." },
      { ok: false, error: "no_reply must be called alone before any other tool." }
    ]);
    expect(delivered).toEqual([]);
    expect(used).toEqual([]);
  });

  it("forces dispatch_message into deferred definitions after prompt overrides", () => {
    const executor = new RegistryProviderToolExecutor();
    const [codex] = executor.resolveDefinitions({ asyncCodex: true }, [staleTool("codex")]);
    const parameters = codex?.parameters as Record<string, any>;

    expect(parameters.properties.dispatch_message).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 200
    });
    expect(parameters.required).toContain("dispatch_message");
    expect(codex?.strict).toBe(true);
  });

  it("treats image tools as deferred only in asynchronous image turns", () => {
    const executor = new RegistryProviderToolExecutor();
    const base = {
      bot: { tools: { generateImg: {} } },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const [deferredImage] = executor.resolveDefinitions(base, [staleTool("generate_img")]);
    const deferredParameters = deferredImage?.parameters as Record<string, any>;
    const [inlineImage] = executor.resolveDefinitions({ ...base, asyncImage: false }, [staleTool("generate_img")]);
    const inlineParameters = inlineImage?.parameters as Record<string, any>;

    expect(providerToolExecutionMode("generate_img", { asyncImage: true })).toBe("deferred");
    expect(providerToolExecutionMode("generate_img", { asyncImage: false })).toBe("inline");
    expect(deferredParameters.required).toContain("dispatch_message");
    expect(inlineParameters.properties.dispatch_message).toBeUndefined();
    expect(inlineParameters.required).not.toContain("dispatch_message");
  });

  it("restores the canonical history-reference contract over stale prompt schemas", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      bot: { tools: { generateImg: {} } },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const definition = executor.resolveDefinitions(options, [staleTool("generate_img")])
      .find((item) => item.name === "generate_img");
    const parameters = definition?.parameters as Record<string, any>;

    expect(definition?.description).toContain("historical media handles");
    expect(parameters.properties.referenceMediaHandles).toMatchObject({
      type: ["array", "null"],
      maxItems: 4
    });
    expect(parameters.properties.referenceImageSource.enum).toEqual([
      "none",
      "current",
      "previous_output",
      "history",
      "current_and_history"
    ]);
    expect(parameters.required).toEqual(expect.arrayContaining([
      "referenceMediaHandles",
      "referenceImageSource",
      "dispatch_message"
    ]));
    expect(parameters.properties.task).toBeUndefined();
  });

  it("restores the canonical history-reference contract for selfie", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      selfie: { enabled: true },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const definition = executor.resolveDefinitions(options, [staleTool("selfie")])
      .find((item) => item.name === "selfie");
    const parameters = definition?.parameters as Record<string, any>;

    expect(definition?.description).toContain("historical media handles");
    expect(parameters.properties.referenceMediaHandles).toMatchObject({
      type: ["array", "null"],
      maxItems: 4
    });
    expect(parameters.properties.referenceImageSource.enum).toEqual([
      "none",
      "current",
      "previous_output",
      "history",
      "current_and_history"
    ]);
    expect(parameters.required).toEqual(expect.arrayContaining([
      "referenceMediaHandles",
      "referenceImageSource",
      "dispatch_message"
    ]));
  });

  it("removes image tools when the delivery target cannot receive image tasks", () => {
    const options = {
      imageTools: false,
      asyncImage: true,
      bot: { tools: { generateImg: {} } },
      selfie: { enabled: true }
    } as unknown as ProviderCompleteOptions;

    expect(resolveProviderToolDefinitions(options, [
      staleTool("generate_img"),
      staleTool("selfie")
    ])).toEqual([]);
    expect(listToolMetadata(options).filter((tool) => ["generate_img", "selfie"].includes(tool.name)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "generate_img", available: false, effectiveEnabled: false }),
        expect.objectContaining({ name: "selfie", available: false, effectiveEnabled: false })
      ]));
  });

  it("applies global description overrides after prompt definitions", () => {
    const options = {
      bot: {
        tools: {
          websearch: {},
          generateImg: {},
          overrides: { websearch: { description: "Search using the configured live index." } }
        }
      }
    } as unknown as ProviderCompleteOptions;
    const [definition] = resolveProviderToolDefinitions(options, [staleTool("websearch")]);
    const [metadata] = listToolMetadata(options, [staleTool("websearch")])
      .filter((tool) => tool.name === "websearch");

    expect(definition?.description).toBe("Search using the configured live index.");
    expect(metadata).toMatchObject({
      description: "Search using the configured live index.",
      promptDescription: "Stale workspace definition.",
      descriptionSource: "override",
      enabled: true,
      available: true,
      effectiveEnabled: true
    });
    expect(metadata?.parameters).toMatchObject({
      properties: { task: { type: "string" } }
    });
  });

  it("lets an explicit enable restore a canonical tool omitted by the prompt", () => {
    const options = {
      bot: {
        tools: {
          websearch: {},
          generateImg: {},
          overrides: { websearch: { enabled: true } }
        }
      }
    } as unknown as ProviderCompleteOptions;

    expect(resolveProviderToolDefinitions(options, []).map((tool) => tool.name)).toEqual(["websearch"]);
    expect(listToolMetadata(options, []).find((tool) => tool.name === "websearch")).toMatchObject({
      configuredEnabled: true,
      promptEnabled: false,
      enabled: true,
      available: true,
      effectiveEnabled: true,
      descriptionSource: "default"
    });
  });

  it("ignores generic enabled overrides for direct-runtime tools", () => {
    const options = {
      asyncCodex: true,
      bot: {
        tools: {
          websearch: {},
          generateImg: {},
          overrides: { codex: { enabled: false, description: "Direct Codex description." } }
        }
      }
    } as unknown as ProviderCompleteOptions;

    expect(resolveProviderToolDefinitions(options, [staleTool("codex")])).toEqual([
      expect.objectContaining({ name: "codex", description: "Direct Codex description." })
    ]);
    expect(providerToolExecutionMode("codex", options)).toBe("deferred");
    expect(listToolMetadata(options, [staleTool("codex")]).find((tool) => tool.name === "codex"))
      .toMatchObject({ configuredEnabled: null, enabled: true });
  });

  it("does not dispatch or execute a deferred tool whose runtime capability is unavailable", async () => {
    const options = {
      asyncCodex: false,
      bot: { tools: { websearch: {}, generateImg: {} } }
    } as unknown as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const call = {
      type: "function_call" as const,
      name: "codex",
      call_id: "call-unavailable",
      arguments: JSON.stringify({ task: "inspect", kind: "analysis", dispatch_message: "开始处理。" })
    };

    expect(providerToolExecutionMode("codex", options)).toBe("deferred");
    const definitions = executor.resolveDefinitions(options, [staleTool("codex")]);
    expect(definitions).toEqual([]);
    expect(executor.deferredTurn([call], options, definitions)).toBeNull();
    const [output] = await executor.execute([call], options, definitions);
    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: "Tool codex is unavailable." });
  });

  it("does not expose or execute the unsupported custom image provider", async () => {
    const options = {
      asyncImage: true,
      bot: {
        tools: {
          websearch: {},
          generateImg: { provider: "custom" }
        }
      }
    } as unknown as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("generate_img")]);
    const metadata = listToolMetadata(options, [staleTool("generate_img")])
      .find((tool) => tool.name === "generate_img");
    const call = {
      type: "function_call" as const,
      name: "generate_img",
      call_id: "call-custom-image",
      arguments: JSON.stringify({ prompt: "test", dispatch_message: "开始处理。" })
    };

    expect(definitions).toEqual([]);
    expect(metadata).toMatchObject({
      enabled: true,
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前图像生成 Provider 不可用。"
    });
    expect(executor.deferredTurn([call], options, definitions)).toBeNull();
    const [output] = await executor.execute([call], options, definitions);
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool generate_img is unavailable."
    });
  });

  it("returns the effective deferred parameter schema in metadata", () => {
    const options = {
      asyncCodex: true,
      asyncImage: true,
      bot: { tools: { websearch: {}, generateImg: {} } }
    } as unknown as ProviderCompleteOptions;
    const metadata = listToolMetadata(options);
    const codex = metadata.find((tool) => tool.name === "codex");
    const image = metadata.find((tool) => tool.name === "generate_img");

    expect(codex).toMatchObject({ execution: "deferred", available: true, effectiveEnabled: true });
    expect((codex?.parameters.properties as Record<string, unknown>).dispatch_message).toBeDefined();
    expect(image?.execution).toBe("deferred");
    expect((image?.parameters.properties as Record<string, unknown>).dispatch_message).toBeDefined();
  });

  it("rejects an inline call omitted by the current prompt", async () => {
    const delivered: string[] = [];
    const used: string[] = [];
    const options = {
      onAssistantText: (text: string) => { delivered.push(text); },
      onToolCall: (name: string) => { used.push(name); }
    } as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute([{
      type: "function_call",
      name: "assistant_text",
      call_id: "call-undeclared-inline",
      arguments: JSON.stringify({ text: "undeclared" })
    }], options, definitions);

    expect(definitions).toEqual([]);
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool assistant_text is not enabled for this prompt."
    });
    expect(delivered).toEqual([]);
    expect(used).toEqual([]);
  });

  it("reports accepted inline and deferred tool calls with assistant message sources", async () => {
    const used: string[] = [];
    const delivered: Array<{ text: string; source: string | undefined }> = [];
    const executor = new RegistryProviderToolExecutor();
    const inlineOptions = {
      onAssistantText: (text: string, source?: "text" | "assistant_text") => {
        delivered.push({ text, source });
      },
      onToolCall: (name: string) => used.push(name)
    } satisfies ProviderCompleteOptions;
    const inlineDefinitions = executor.resolveDefinitions(inlineOptions, [staleTool("assistant_text")]);

    await executor.execute([{
      type: "function_call",
      name: "assistant_text",
      call_id: "call-assistant-text",
      arguments: JSON.stringify({ text: "正在处理。" })
    }], inlineOptions, inlineDefinitions);

    const deferredOptions = {
      asyncCodex: true,
      onToolCall: (name: string) => used.push(name)
    } satisfies ProviderCompleteOptions;
    const deferredDefinitions = executor.resolveDefinitions(deferredOptions, [staleTool("codex")]);
    const deferred = executor.deferredTurn([{
      type: "function_call",
      name: "codex",
      call_id: "call-codex",
      arguments: JSON.stringify({
        task: "inspect",
        kind: "analysis",
        dispatch_message: "开始处理。"
      })
    }], deferredOptions, deferredDefinitions);

    expect(delivered).toEqual([{ text: "正在处理。", source: "assistant_text" }]);
    expect(used).toEqual(["assistant_text", "codex"]);
    expect(deferred).toMatchObject({
      kind: "deferred",
      toolCall: { name: "codex", callId: "call-codex" }
    });
  });

  it("rejects a deferred call omitted by the current prompt", async () => {
    const used: string[] = [];
    const options = {
      asyncCodex: true,
      onToolCall: (name: string) => { used.push(name); }
    } as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const call = {
      type: "function_call" as const,
      name: "codex",
      call_id: "call-undeclared-deferred",
      arguments: JSON.stringify({ task: "inspect", kind: "analysis", dispatch_message: "开始处理。" })
    };

    expect(definitions).toEqual([]);
    expect(executor.deferredTurn([call], options, definitions)).toBeNull();
    const [output] = await executor.execute([call], options, definitions);
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool codex is not enabled for this prompt."
    });
    expect(used).toEqual([]);
  });
});

function staleTool(name: string): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: "Stale workspace definition.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { task: { type: "string" } },
        required: ["task"]
      },
      strict: false
    }
  };
}
