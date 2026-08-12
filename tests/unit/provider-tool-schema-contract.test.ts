// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { codexTool } from "../../services/tools/definitions.js";
import {
  OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYWORDS,
  PROVIDER_TOOL_SCHEMA_CONTRACTS,
  assertMappedProviderToolDefinitions,
  assertProviderToolDefinition,
  type ProviderToolSchemaProtocol
} from "../../services/tools/providerToolSchema.js";
import {
  readCodexInputHandles as readPreparedCodexInputHandles
} from "../../adapters/codex/codexInputs.js";
import {
  readCodexInputHandles as readDeferredCodexInputHandles
} from "../../src/runtime/deferredCodexArtifacts.js";
import {
  toAnthropicTool,
  toChatCompletionTool,
  toGeminiFunctionDeclaration
} from "../../adapters/model/provider/promptMapping.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";
import type { OpenAIToolDefinition } from "../../services/agent/promptSystem.js";
import { listToolMetadata } from "../../services/tools/toolRegistry.js";
import { AGENT_TOOL_NAMES } from "../../packages/contracts/admin/public.js";
import { addWorkMemoryTool } from "../../services/tools/addWorkMemoryTool.js";
import { addUserProfileTool } from "../../services/tools/addUserProfileTool.js";

describe("Provider tool schema compatibility contract", () => {
  it("keeps the recorded OpenAI strict unsupported keywords in one protocol contract", () => {
    expect(OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYWORDS).toEqual([
      "uniqueItems",
      "oneOf",
      "allOf",
      "not",
      "dependentRequired",
      "dependentSchemas",
      "if",
      "then",
      "else"
    ]);
    expect(PROVIDER_TOOL_SCHEMA_CONTRACTS["anthropic-messages"].strictUnsupportedKeywords)
      .toEqual([]);
    expect(PROVIDER_TOOL_SCHEMA_CONTRACTS["gemini-generate-content"].strictUnsupportedKeywords)
      .toEqual([]);
  });

  it.each([
    "openai-responses",
    "codex-responses",
    "openai-chat-completions"
  ] satisfies ProviderToolSchemaProtocol[])(
    "rejects the exact inputHandles uniqueItems failure before %s transport",
    (protocol) => {
      expect(() => assertProviderToolDefinition(
        codexDefinitionWithUniqueItems(),
        protocol
      )).toThrow(/codex.*properties\.inputHandles.*uniqueItems/u);
    }
  );

  it.each(
    Object.keys(PROVIDER_TOOL_SCHEMA_CONTRACTS) as ProviderToolSchemaProtocol[]
  )("rejects malformed common JSON Schema structures for %s", (protocol) => {
    expect(() => assertProviderToolDefinition({
      name: "malformed_type",
      strict: true,
      parameters: strictRoot({ type: 42 })
    }, protocol)).toThrow(/invalid type/u);

    expect(() => assertProviderToolDefinition({
      name: "malformed_properties",
      strict: true,
      parameters: {
        type: "object",
        properties: [],
        required: [],
        additionalProperties: false
      }
    }, protocol)).toThrow(/properties must be an object/u);

    for (const malformed of [
      strictRoot({ required: "value", additionalProperties: false }),
      strictRoot({ type: "array", items: "value" }),
      strictRoot({ anyOf: [] }),
      strictRoot({ contains: "value" }),
      strictRoot({ type: "string", enum: [] }),
      strictRoot({ type: "string", pattern: "[" }),
      strictRoot({ type: "array", uniqueItems: "yes", items: { type: "string" } })
    ]) {
      expect(() => assertProviderToolDefinition({
        name: "malformed_container",
        strict: true,
        parameters: malformed
      }, protocol)).toThrow(/PROVIDER_TOOL_SCHEMA_INVALID/u);
    }
  });

  it.each([
    "openai-responses",
    "codex-responses",
    "openai-chat-completions"
  ] satisfies ProviderToolSchemaProtocol[])(
    "rejects inherited prototype names in strict required lists for %s",
    (protocol) => {
      expect(() => assertProviderToolDefinition({
        name: "prototype_required",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: ["toString"],
          additionalProperties: false
        }
      }, protocol)).toThrow(/required property toString must be defined/u);
    }
  );

  it.each([
    "anthropic-messages",
    "gemini-generate-content"
  ] satisfies ProviderToolSchemaProtocol[])(
    "does not apply the OpenAI strict keyword list to %s without a matching contract",
    (protocol) => {
      expect(() => assertProviderToolDefinition(
        codexDefinitionWithUniqueItems(),
        protocol
      )).not.toThrow();
    }
  );

  it.each([
    "openai-responses",
    "codex-responses",
    "openai-chat-completions"
  ] satisfies ProviderToolSchemaProtocol[])(
    "recursively rejects strict unsupported keywords in every schema container for %s",
    (protocol) => {
      for (const parameters of nestedUnsupportedKeywordParameters()) {
        expect(() => assertProviderToolDefinition({
          name: "nested_schema_fixture",
          strict: true,
          parameters
        }, protocol)).toThrow(/uniqueItems|additionalProperties=false/u);
      }
    }
  );

  it.each([
    "openai-responses",
    "codex-responses",
    "openai-chat-completions"
  ] satisfies ProviderToolSchemaProtocol[])(
    "enforces strict shape for nullable object schemas in %s",
    (protocol) => {
      expect(() => assertProviderToolDefinition({
        name: "nullable_object_additional_properties",
        strict: true,
        parameters: strictRoot({
          type: ["object", "null"],
          properties: {},
          required: [],
          additionalProperties: true
        })
      }, protocol)).toThrow(/additionalProperties=false/u);

      expect(() => assertProviderToolDefinition({
        name: "nullable_object_required",
        strict: true,
        parameters: strictRoot({
          type: ["object", "null"],
          properties: { value: { type: "string" } },
          required: [],
          additionalProperties: false
        })
      }, protocol)).toThrow(/property value must be required/u);
    }
  );

  it.each([
    "openai-responses",
    "codex-responses",
    "openai-chat-completions"
  ] satisfies ProviderToolSchemaProtocol[])(
    "enforces strict shape for implicit object schemas in %s",
    (protocol) => {
      expect(() => assertProviderToolDefinition({
        name: "implicit_object_additional_properties",
        strict: true,
        parameters: strictRoot({
          properties: {},
          required: []
        })
      }, protocol)).toThrow(/additionalProperties=false/u);

      expect(() => assertProviderToolDefinition({
        name: "implicit_object_required",
        strict: true,
        parameters: strictRoot({
          properties: { value: { type: "string" } },
          required: [],
          additionalProperties: false
        })
      }, protocol)).toThrow(/property value must be required/u);
    }
  );

  it("validates every protocol-mapped tool shape before transport", () => {
    const canonical = structuredClone(codexTool) as unknown as Record<string, unknown>;
    expect(() => assertMappedProviderToolDefinitions(
      [canonical],
      "openai-responses"
    )).not.toThrow();
    expect(() => assertMappedProviderToolDefinitions(
      [canonical],
      "codex-responses"
    )).not.toThrow();
    expect(() => assertMappedProviderToolDefinitions(
      [toChatCompletionTool(canonical)],
      "openai-chat-completions"
    )).not.toThrow();
    expect(() => assertMappedProviderToolDefinitions(
      [toAnthropicTool(canonical)],
      "anthropic-messages"
    )).not.toThrow();
    expect(() => assertMappedProviderToolDefinitions(
      [toGeminiFunctionDeclaration(canonical)],
      "gemini-generate-content"
    )).not.toThrow();
  });

  it("keeps add_workmemory strict with required nullable content on every Provider protocol", () => {
    const canonical = structuredClone(addWorkMemoryTool) as unknown as Record<string, any>;
    expect(canonical).toMatchObject({
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "content"],
        properties: {
          action: { type: "string", enum: ["record", "skip"] },
          content: { type: ["string", "null"] }
        }
      }
    });

    const mapped = {
      "openai-responses": canonical,
      "codex-responses": canonical,
      "openai-chat-completions": toChatCompletionTool(canonical),
      "anthropic-messages": toAnthropicTool(canonical),
      "gemini-generate-content": toGeminiFunctionDeclaration(canonical)
    } satisfies Record<ProviderToolSchemaProtocol, Record<string, unknown>>;
    for (const protocol of Object.keys(mapped) as ProviderToolSchemaProtocol[]) {
      expect(() => assertMappedProviderToolDefinitions([mapped[protocol]], protocol)).not.toThrow();
    }
    expect(mapped["gemini-generate-content"]).toHaveProperty("parametersJsonSchema");
    expect(mapped["gemini-generate-content"]).not.toHaveProperty("parameters");
  });

  it("keeps add_user_profile strict with required nullable aggregate fields on every Provider protocol", () => {
    const canonical = structuredClone(addUserProfileTool) as unknown as Record<string, any>;
    expect(canonical).toMatchObject({
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "profile", "addressNames"],
        properties: {
          action: { type: "string", enum: ["record", "skip"] },
          profile: { type: ["string", "null"] },
          addressNames: { type: ["array", "null"] }
        }
      }
    });
    for (const [protocol, mapped] of Object.entries({
      "openai-responses": canonical,
      "codex-responses": canonical,
      "openai-chat-completions": toChatCompletionTool(canonical),
      "anthropic-messages": toAnthropicTool(canonical),
      "gemini-generate-content": toGeminiFunctionDeclaration(canonical)
    }) as Array<[ProviderToolSchemaProtocol, Record<string, unknown>]>) {
      expect(() => assertMappedProviderToolDefinitions([mapped], protocol)).not.toThrow();
    }
  });

  it.each([
    ["standard deferred tools", false, true],
    ["control Codex and inline image tools", true, false]
  ] as const)(
    "scans all resolved built-in, prompt, MCP and dispatch schemas in %s",
    (_label, codexControl, asyncImage) => {
      const options = fullToolOptions({ codexControl, asyncImage });
      const promptDefinitions = promptDefinitionsFor(options);
      const executor = new RegistryProviderToolExecutor();
      const protocols = Object.keys(
        PROVIDER_TOOL_SCHEMA_CONTRACTS
      ) as ProviderToolSchemaProtocol[];

      for (const protocol of protocols) {
        const resolved = executor.resolveDefinitions(
          options,
          promptDefinitions,
          protocol
        );
        expect(resolved.map((tool) => String(tool.name)).filter((name) => !name.startsWith("mcp_")))
          .toEqual(AGENT_TOOL_NAMES);
        const mapped = mapForProtocol(resolved, protocol);
        expect(() => assertMappedProviderToolDefinitions(mapped, protocol)).not.toThrow();

        const codex = resolved.find((tool) => tool.name === "codex") as Record<string, any>;
        expect(codex.parameters.properties.inputHandles?.uniqueItems).toBeUndefined();
        if (!codexControl) {
          expect(codex.parameters.properties.dispatch_message).toBeDefined();
        }
        const forbidden = new Set(
          PROVIDER_TOOL_SCHEMA_CONTRACTS[protocol].strictUnsupportedKeywords
        );
        if (forbidden.size) {
          expect(findKeywords(mapped, forbidden)).toEqual([]);
        }
      }
    }
  );

  it("quarantines an incompatible final MCP definition only for matching protocols", () => {
    const name = `mcp_${"a".repeat(48)}`;
    const invalidMcp = {
      type: "function",
      name,
      description: "Recorded invalid schema fixture.",
      strict: true,
      parameters: codexDefinitionWithUniqueItems().parameters
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executor = new RegistryProviderToolExecutor();
    const options = {
      mcp: {
        definitions: () => [invalidMcp],
        describe: () => ({ serverId: "fixture", transport: "streamable_http" as const }),
        call: vi.fn()
      }
    } as unknown as ProviderCompleteOptions;

    expect(executor.resolveDefinitions(options, [], "codex-responses")).toEqual([]);
    expect(executor.resolveDefinitions(options, [], "anthropic-messages").map((tool) => tool.name))
      .toEqual([name]);
    expect(errorLog).toHaveBeenCalledWith(
      "[provider] invalid tool definition quarantined",
      expect.objectContaining({
        tool: name,
        error: expect.stringContaining("properties.inputHandles")
      })
    );
    errorLog.mockRestore();
  });

  it("quarantines only the malformed common MCP schema and retains valid tools", () => {
    const validName = `mcp_${"c".repeat(48)}`;
    const invalidName = `mcp_${"d".repeat(48)}`;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executor = new RegistryProviderToolExecutor();
    const options = {
      mcp: {
        definitions: () => [
          {
            type: "function",
            name: validName,
            description: "Valid dynamic MCP fixture.",
            strict: true,
            parameters: strictRoot({ type: "string" })
          },
          {
            type: "function",
            name: invalidName,
            description: "Malformed dynamic MCP fixture.",
            strict: true,
            parameters: strictRoot({ type: 42 })
          }
        ],
        describe: () => ({ serverId: "fixture", transport: "streamable_http" as const }),
        call: vi.fn()
      }
    } as unknown as ProviderCompleteOptions;

    expect(executor.resolveDefinitions(options, [], "anthropic-messages").map((tool) => tool.name))
      .toEqual([validName]);
    expect(errorLog).toHaveBeenCalledWith(
      "[provider] invalid tool definition quarantined",
      expect.objectContaining({
        tool: invalidName,
        error: expect.stringContaining("invalid type")
      })
    );
    errorLog.mockRestore();
  });

  it("pairs the schema downgrade with both host-side duplicate rejections", () => {
    const duplicate = ["message:1:file:0", "message:1:file:0"];
    expect(() => readDeferredCodexInputHandles(duplicate))
      .toThrow("CODEX_INPUT_HANDLES_INVALID");
    expect(() => readPreparedCodexInputHandles(duplicate))
      .toThrow("Codex input handles are invalid.");
  });
});

function codexDefinitionWithUniqueItems() {
  const definition = structuredClone(codexTool) as unknown as Record<string, any>;
  definition.parameters.properties.inputHandles.uniqueItems = true;
  return definition;
}

function nestedUnsupportedKeywordParameters() {
  return [
    strictRoot({
      type: "array",
      contains: { type: "array", uniqueItems: true }
    }),
    strictRoot({
      type: "array",
      prefixItems: [{ type: "array", uniqueItems: true }]
    }),
    strictRoot({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      patternProperties: {
        "^fixture$": { type: "array", uniqueItems: true }
      }
    }),
    strictRoot({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      propertyNames: { type: "array", uniqueItems: true }
    }),
    strictRoot({
      additionalProperties: { type: "array", uniqueItems: true }
    })
  ];
}

function strictRoot(child: Record<string, unknown>) {
  return {
    type: "object",
    properties: { fixture: child },
    required: ["fixture"],
    additionalProperties: false
  };
}

function fullToolOptions(mode: { codexControl: boolean; asyncImage: boolean }) {
  const nativeBash = bashOptions();
  return {
    onAssistantText: vi.fn(),
    allowNoReply: true,
    workbenchFiles: { read: vi.fn(), write: vi.fn() },
    chatMedia: {
      export: vi.fn(),
      importEmoji: vi.fn(),
      importSelfie: vi.fn()
    },
    bash: nativeBash,
    bot: {
      tools: {
        websearch: {},
        generateImg: { provider: "openai" }
      }
    },
    memory: { enabled: true, recall: vi.fn() },
    knowledge: { enabled: true },
    selfie: { enabled: true, run: vi.fn() },
    conversationAssets: { enabled: true, send: vi.fn() },
    voice: { enabled: true, languages: ["zh"], defaultLanguage: "zh" },
    asyncCodex: true,
    codexControl: mode.codexControl,
    asyncImage: mode.asyncImage,
    imageTools: true,
    systemConfig: { execute: vi.fn(), mutationStaged: () => false },
    cron: { execute: vi.fn() },
    director: { execute: vi.fn() },
    air: { execute: vi.fn() },
    workingMemory: { execute: vi.fn() },
    userProfile: { execute: vi.fn() },
    skills: {
      skillIds: ["fixture-skill"],
      activate: vi.fn(),
      readResource: vi.fn(),
      runScript: vi.fn()
    },
    mcp: {
      definitions: () => [{
        type: "function",
        name: `mcp_${"b".repeat(48)}`,
        description: "Valid dynamic MCP fixture.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false
        },
        strict: true
      }],
      describe: () => ({ serverId: "fixture", transport: "streamable_http" as const }),
      call: vi.fn()
    }
  } as unknown as ProviderCompleteOptions;
}

function bashOptions() {
  return {
    enabled: true,
    workspacePath: "/fixture/workbench",
    backend: "native" as const,
    accessMode: "admin" as const,
    strictMode: true,
    isAdmin: true,
    userRequest: "Schema contract fixture.",
    isCurrent: () => true,
    audit: vi.fn(),
    approvalContext: {
      backend: "native" as const,
      agentId: "plana",
      accountId: "primary",
      transport: "onebot",
      conversationId: "account:primary:private:1001",
      userId: "1001"
    }
  };
}

function promptDefinitionsFor(options: ProviderCompleteOptions): OpenAIToolDefinition[] {
  return listToolMetadata(options).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict
    }
  }));
}

function mapForProtocol(
  definitions: Record<string, unknown>[],
  protocol: ProviderToolSchemaProtocol
) {
  if (protocol === "openai-chat-completions") {
    return definitions.map(toChatCompletionTool);
  }
  if (protocol === "anthropic-messages") {
    return definitions.map(toAnthropicTool);
  }
  if (protocol === "gemini-generate-content") {
    return definitions.map(toGeminiFunctionDeclaration);
  }
  return definitions;
}

function findKeywords(value: unknown, keywords: ReadonlySet<string>, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findKeywords(item, keywords, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(keywords.has(key) ? [`${path}.${key}`] : []),
    ...findKeywords(item, keywords, path ? `${path}.${key}` : key)
  ]);
}
