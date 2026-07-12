import { describe, expect, it } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { OpenAIToolDefinition } from "../../services/agent/promptSystem.js";
import { listToolMetadata, providerToolExecutionMode, resolveProviderToolDefinitions } from "../../services/tools/toolRegistry.js";

describe("ToolRegistry", () => {
  it("uses one canonical name for metadata and the model definition", () => {
    const metadata = listToolMetadata();
    const definitions = resolveProviderToolDefinitions({
      bash: { enabled: true, workspaceOnly: true, blockedKeywords: [] }
    });
    const names = definitions.map((definition) => String(definition.name));

    expect(metadata.some((tool) => tool.name === "workspace_bash")).toBe(true);
    expect(metadata.some((tool) => tool.name === "bash.run")).toBe(false);
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
