import { describe, expect, it } from "vitest";
import { promptCacheKey } from "../../adapters/model/provider/promptCaching.js";
import { migrateConversationAirTemplate } from "../../services/agent/airPromptMigration.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import {
  migrateConversationPromptCacheLayoutTemplate
} from "../../services/agent/promptCacheLayoutMigration.js";
import {
  extractPromptVariables,
  renderFinalPromptTemplate,
  type FinalPromptTemplate
} from "../../services/agent/promptSystem.js";

const responseFormat = { type: "text" };
const dynamicVariables = [
  "conversation.emoji.keys",
  "conversation.emoji.syntax",
  "conversation.voice.settings",
  "conversation.voice.trigger_policy",
  "conversation.director.schedule",
  "conversation.group.orchestrator_result",
  "persona.air",
  "memory.working",
  "memory.long_term",
  "memory.user_profile"
] as const;

describe("conversation prompt cache layout migration", () => {
  it("moves volatile group context behind history while preserving the prompt contract", () => {
    const tools = [{
      type: "function" as const,
      function: {
        name: "keep_me",
        description: "custom tool",
        parameters: { type: "object" }
      }
    }];
    const legacy: FinalPromptTemplate = {
      messages: [
        {
          role: "system",
          content: [
            "<stable>@{persona.soul}</stable>",
            "<long_term_memory>@{memory.long_term}</long_term_memory>",
            "<air_knowledge>@{persona.air}</air_knowledge>"
          ].join("\n\n"),
          custom: true
        },
        {
          role: "developer",
          content: [
            "<working_memory>@{memory.working}</working_memory>",
            "<user_profile>@{memory.user_profile}</user_profile>"
          ].join("\n\n")
        },
        "@{messages_64}",
        {
          role: "developer",
          content: "<orchestrator_result>@{conversation.group.orchestrator_result}</orchestrator_result>"
        },
        {
          role: "developer",
          content: [
            "<emoji_keys>@{conversation.emoji.keys}</emoji_keys>",
            "<emoji_syntax>@{conversation.emoji.syntax}</emoji_syntax>"
          ].join("\n\n")
        },
        {
          role: "developer",
          content: [
            "<voice_settings>@{conversation.voice.settings}</voice_settings>",
            "<voice_policy>@{conversation.voice.trigger_policy}</voice_policy>"
          ].join("\n\n")
        },
        {
          role: "developer",
          content: "<schedule>@{conversation.director.schedule}</schedule>"
        },
        {
          role: "user",
          content: [
            "<time>@{runtime.current_time}</time>",
            "<current>@{user.input}</current>"
          ].join("\n\n")
        }
      ],
      tools,
      response_format: responseFormat,
      customRoot: "preserved"
    };

    const migrated = migrateConversationPromptCacheLayoutTemplate(legacy);
    const historyIndex = migrated.messages.indexOf("@{messages_64}");
    expect(historyIndex).toBe(1);
    expect(variableMessageIndex(migrated, "conversation.emoji.keys")).toBe(2);
    expect(variableMessageIndex(migrated, "conversation.voice.settings")).toBe(3);
    expect(variableMessageIndex(migrated, "conversation.director.schedule")).toBe(4);
    expect(variableMessageIndex(migrated, "conversation.group.orchestrator_result")).toBe(5);
    expect(variableMessageIndex(migrated, "persona.air")).toBe(6);
    expect(variableMessageIndex(migrated, "memory.working")).toBe(6);
    expect(variableMessageIndex(migrated, "memory.long_term")).toBe(6);
    expect(variableMessageIndex(migrated, "memory.user_profile")).toBe(6);
    expect(variableMessageIndex(migrated, "runtime.current_time")).toBe(6);
    expect(variableMessageIndex(migrated, "user.input")).toBe(6);
    expect(systemVariables(migrated)).toEqual(["persona.soul"]);
    expect(migrated.tools).toBe(tools);
    expect(migrated.response_format).toBe(responseFormat);
    expect(migrated.customRoot).toBe("preserved");
    expect(migrateConversationPromptCacheLayoutTemplate(migrated)).toBe(migrated);
  });

  it("leaves mixed custom paragraphs intact instead of moving partial administrator content", () => {
    const custom: FinalPromptTemplate = {
      messages: [
        {
          role: "system",
          content: "<custom>@{persona.soul} / @{persona.air}</custom>"
        },
        {
          role: "user",
          content: "<current>@{user.input}</current>"
        }
      ],
      response_format: responseFormat
    };

    expect(migrateConversationPromptCacheLayoutTemplate(custom)).toBe(custom);
  });

  it("adds a missing AIR snapshot to the trailing user context", () => {
    const template: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "<stable>@{persona.soul}</stable>" },
        "@{messages_64}",
        { role: "user", content: "<current>@{user.input}</current>" }
      ],
      tools: [],
      response_format: responseFormat
    };
    const canonical: FinalPromptTemplate = {
      ...template,
      tools: [{
        type: "function",
        function: {
          name: "read_air",
          description: "Read AIR",
          parameters: { type: "object" }
        }
      }]
    };

    const migrated = migrateConversationAirTemplate(template, canonical);
    expect(migrated).toBeDefined();
    if (!migrated) return;
    expect(systemVariables(migrated)).toEqual(["persona.soul"]);
    expect(variableMessageIndex(migrated, "persona.air")).toBe(2);
    expect(migrated.tools?.map((tool) => tool.function.name)).toEqual(["read_air"]);
  });

  it.each(["conversation.private-reply", "conversation.group-reply"])(
    "keeps the %s default system prefix free of volatile request variables",
    (promptId) => {
      const template = defaultFinalPromptTemplate(promptId);
      expect(template).toBeDefined();
      if (!template) return;
      const historyIndex = template.messages.indexOf("@{messages_64}");
      expect(historyIndex).toBeGreaterThanOrEqual(0);
      expect(systemVariables(template)).not.toEqual(
        expect.arrayContaining(dynamicVariables)
      );
      for (const variable of dynamicVariables) {
        const index = variableMessageIndex(template, variable);
        if (index >= 0) expect(index).toBeGreaterThan(historyIndex);
      }
      expect(variableMessageIndex(template, "runtime.current_time")).toBeGreaterThan(historyIndex);
      expect(variableMessageIndex(template, "user.input")).toBeGreaterThan(historyIndex);
    }
  );

  it("keeps the group cache key stable when per-turn context changes", () => {
    const template = defaultFinalPromptTemplate("conversation.group-reply");
    expect(template).toBeDefined();
    if (!template) return;
    const first = renderFinalPromptTemplate(template, conversationVariables("first"));
    const second = renderFinalPromptTemplate(template, conversationVariables("second"));
    const provider = {
      id: "codex-main",
      label: "Codex",
      kind: "codex-responses" as const,
      enabled: true,
      model: "gpt-5.6-terra",
      imageModel: "gpt-image-2",
      apiKeyEnv: "CODEX_ACCESS_TOKEN",
      temperature: 0.2,
      maxOutputTokens: 1_200
    };
    const context = {
      conversationId: "group:1",
      stage: "reply",
      promptFamily: "conversation.group-reply"
    };
    const key = (request: ReturnType<typeof renderFinalPromptTemplate>) => promptCacheKey(
      provider,
      context,
      {
        staticPrefix: request.messages.filter((message) => message.role === "system"),
        tools: request.tools ?? [],
        responseFormat: request.response_format
      }
    );

    expect(first.messages.filter((message) => message.role === "system")).toEqual(
      second.messages.filter((message) => message.role === "system")
    );
    expect(key(first)).toBe(key(second));
  });
});

function systemVariables(template: FinalPromptTemplate) {
  return template.messages.flatMap((message) => (
    isPromptMessage(message) && message.role === "system"
      ? extractPromptVariables(message.content)
      : []
  ));
}

function variableMessageIndex(template: FinalPromptTemplate, variable: string) {
  return template.messages.findIndex((message) => (
    isPromptMessage(message) && extractPromptVariables(message.content).includes(variable)
  ));
}

function isPromptMessage(
  value: FinalPromptTemplate["messages"][number]
): value is Record<string, unknown> & { role: string; content: string } {
  return typeof value === "object"
    && value != null
    && !Array.isArray(value)
    && typeof value.role === "string"
    && typeof value.content === "string";
}

function conversationVariables(suffix: string) {
  return {
    "persona.agents": "agent",
    "persona.soul": "soul",
    "persona.preference": "preference",
    "persona.dialogue_style_examples": "examples",
    "persona.user": "user",
    "persona.relation": "relation",
    "persona.air": `air-${suffix}`,
    "runtime.output_rules": "output",
    "runtime.address_rules": "address",
    "runtime.scope_rules": "scope",
    "runtime.tool_rules": "tools",
    "runtime.current_time": `time-${suffix}`,
    "conversation.emoji.keys": [`emoji-${suffix}`],
    "conversation.emoji.syntax": "emoji syntax",
    "conversation.voice.settings": { enabled: true },
    "conversation.voice.trigger_policy": "voice policy",
    "conversation.director.schedule": `schedule-${suffix}`,
    "conversation.group.orchestrator_result": `orchestrator-${suffix}`,
    "messages_64": [{ role: "user", content: `history-${suffix}` }],
    "memory.working": `working-${suffix}`,
    "memory.long_term": `long-${suffix}`,
    "memory.user_profile": `profile-${suffix}`,
    "user.input": `input-${suffix}`
  };
}
