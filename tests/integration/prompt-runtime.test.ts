// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT_FILE_DEFINITIONS } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  validatePromptFragment,
  type PromptVariableValue
} from "../../services/agent/promptSystem.js";
import { defaultConfig } from "../../src/config.js";
import { defaultVoiceProfile, voicePromptVariables } from "../../services/voice/public.js";

let root = "";
let workspace = "";
let systemWorkspace = "";
const config = defaultConfig();

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prompt-runtime-"));
  workspace = path.join(root, "business/agents/plana");
  systemWorkspace = path.join(root, "business/prompts");
  config.persona.agentWorkspace = workspace;
  config.persona.systemPromptWorkspace = systemWorkspace;
  await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(systemWorkspace, { recursive: true })]);
  await Promise.all(PROMPT_FILE_DEFINITIONS.map((definition) => fs.writeFile(
    path.join(definition.scope === "system" ? systemWorkspace : workspace, definition.fileName(config)),
    definition.kind === "final" ? defaultPromptContent(definition.id) : `${definition.id} fixture\n`,
    "utf8"
  )));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace prompt runtime", () => {
  it("includes cron in the default group reply tools without exposing system_config", () => {
    const template = parseFinalPromptTemplate(defaultPromptContent("conversation.group-reply"));
    const names = template.tools?.map((tool) => tool.function.name);

    expect(names).toContain("cron");
    expect(names).not.toContain("system_config");
  });

  it("parses and resolves every final request template without leftover variables", async () => {
    const fragmentValues = await readFragments();

    for (const definition of PROMPT_FILE_DEFINITIONS.filter((item) => item.kind === "final")) {
      const promptWorkspace = definition.scope === "system" ? systemWorkspace : workspace;
      const content = await fs.readFile(path.join(promptWorkspace, definition.fileName(config)), "utf8");
      const template = parseFinalPromptTemplate(content);
      const variables: Record<string, PromptVariableValue> = { ...fragmentValues };
      for (const variable of definition.variables) {
        if (Object.hasOwn(variables, variable.name)) continue;
        variables[variable.name] = variable.type === "message[]"
          ? [{ role: "assistant", content: "历史回复" }]
          : variable.type === "json"
            ? { fixture: definition.id }
            : variable.type === "boolean"
              ? false
            : `fixture:${variable.name}`;
      }

      const rendered = renderFinalPromptTemplate(template, variables);
      const serialized = JSON.stringify(rendered);

      expect(rendered.messages.some((message) => message.role === "system"), definition.id).toBe(true);
      expect(rendered.messages.some((message) => message.role === "user"), definition.id).toBe(true);
      expect(extractPromptVariables(serialized), definition.id).toEqual([]);
      expect(rendered.response_format, definition.id).toEqual(template.response_format);
    }
  });

  it("assembles the conversation request in system, history and current-user order", async () => {
    const definition = PROMPT_FILE_DEFINITIONS.find((item) => item.id === "conversation.private-reply")!;
    const template = parseFinalPromptTemplate(
      await fs.readFile(path.join(systemWorkspace, definition.fileName(config)), "utf8")
    );
    const rendered = renderFinalPromptTemplate(template, {
      ...await readFragments(),
      "runtime.output_rules": "只输出正文。",
      "runtime.address_rules": "称呼用户为老师。",
      "runtime.scope_rules": "识别会话范围。",
      "runtime.tool_rules": "按需调用工具。",
      "runtime.current_time": "2026-07-19T22:43:55.000+08:00 [system_timezone=Asia/Shanghai]",
      "message_32": [
        { role: "user", content: "上一条问题" },
        { role: "assistant", content: "上一条回复" }
      ],
      "messages_64": [{ role: "user", content: "旧模板兼容历史" }],
      "memory.working": "工作记忆 A",
      "memory.long_term": "长期记忆 B",
      "memory.user_profile": "画像 C",
      "conversation.emoji.keys": ["开心", "认真"],
      "conversation.emoji.syntax": "需要发送表情时输出 [/表情key]。",
      "conversation.director.schedule": "{}",
      ...voicePromptVariables(defaultVoiceProfile()),
      "user.input": "当前问题"
    });

    expect(rendered.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "developer",
      "developer",
      "developer",
      "user"
    ]);
    expect(rendered.messages[0]?.content).toContain("<soul>");
    expect(rendered.messages[0]?.content).toContain("<output_rules>只输出正文。</output_rules>");
    expect(rendered.messages[0]?.content).not.toContain("<air_knowledge>");
    expect(rendered.messages.at(-1)?.content).toContain("<air_knowledge>");
    expect(rendered.messages.at(-1)?.content).toContain("<working_memory>工作记忆 A</working_memory>");
    expect(rendered.messages.at(-1)?.content).toContain("<long_term_memory>长期记忆 B</long_term_memory>");
    expect(rendered.messages.at(-1)?.content).toContain("<user_profile>画像 C</user_profile>");
    expect(rendered.messages[3]?.content).toContain("<emoji_keys>[");
    expect(rendered.messages[3]?.content).toContain('"开心"');
    expect(rendered.messages[3]?.content).toContain('"认真"');
    expect(rendered.messages[3]?.content).toContain("<emoji_syntax>需要发送表情时输出 [/表情key]。</emoji_syntax>");
    expect(rendered.messages.at(-1)?.content).toContain("<current_input>当前问题</current_input>");
    expect(JSON.stringify(rendered.messages)).not.toContain("旧模板兼容历史");
    expect(rendered.tools?.map((tool) => tool.function.name)).toEqual([
      "assistant_text",
      "no_reply",
      "read_file",
      "write_file",
      "native_bash",
      "websearch",
      "webfetch",
      "generate_img",
      "selfie",
      "send_file",
      "send_voice_message",
      "memory_recall",
      "read_air",
      "codex",
      "system_config",
      "cron",
      "call_director"
    ]);
    expect(rendered.tools?.every((tool) => tool.function.description.trim().length > 0)).toBe(true);
    for (const name of ["generate_img", "selfie", "codex"]) {
      const tool = rendered.tools?.find((item) => item.function.name === name);
      const parameters = tool?.function.parameters as Record<string, any>;
      expect(parameters.properties.dispatch_message, name).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 200
      });
      expect(parameters.required, name).toContain("dispatch_message");
    }
  });

  it("exposes every persona fragment to all final prompts and keeps recall sources separate", () => {
    const personaNames = [
      "persona.agents",
      "persona.soul",
      "persona.preference",
      "persona.dialogue_style_examples",
      "persona.user",
      "persona.relation",
      "persona.air"
    ];
    for (const definition of PROMPT_FILE_DEFINITIONS.filter((item) => item.kind === "final")) {
      expect(definition.variables.map((item) => item.name), definition.id).toEqual(expect.arrayContaining(personaNames));
    }
    const conversation = PROMPT_FILE_DEFINITIONS.find((item) => item.id === "conversation.private-reply")!;
    expect(conversation.variables.map((item) => item.name)).toEqual(expect.arrayContaining([
      "message_32",
      "messages_64",
      "memory.working",
      "memory.long_term",
      "memory.user_profile"
    ]));
  });

  it("renders the tone prompt with global persona variables and keeps the outbound text opaque", async () => {
    const definition = PROMPT_FILE_DEFINITIONS.find((item) => item.id === "conversation.tone-rewrite")!;
    expect(definition.variables.map((item) => item.name)).toEqual(expect.arrayContaining([
      "bot.name",
      "user.name",
      "runtime.current_time",
      "utils.roll",
      "persona.agents",
      "persona.soul",
      "persona.preference",
      "persona.dialogue_style_examples",
      "persona.user",
      "persona.relation",
      "persona.air",
      "tone.input",
      "tone_mode",
      "tone.output_contract",
      "tone.available_assets"
    ]));
    const template = parseFinalPromptTemplate(
      await fs.readFile(path.join(systemWorkspace, definition.fileName(config)), "utf8")
    );
    const rendered = renderFinalPromptTemplate(template, {
      ...await readFragments(),
      "bot.name": "普拉娜",
      "user.name": "猫老师",
      "runtime.current_time": "2026-07-18T08:00:00.000Z",
      "utils.roll": 42,
      "tone.input": "保留字面量 @{persona.soul}",
      tone_mode: false,
      "tone.output_contract": "只输出正文",
      "tone.available_assets": "[]"
    }, { opaqueVariables: ["tone.input"] });

    expect(rendered.messages[0]?.content).toContain("<soul>persona.soul fixture");
    expect(rendered.messages[0]?.content).not.toContain("<xml-check>");
    expect(rendered.messages.at(-1)?.content).toContain("保留字面量 @{persona.soul}");
    expect(rendered.tools).toEqual([]);
    expect(rendered.response_format).toEqual({ type: "text" });
  });

  it("keeps reusable MD prompts raw and places their semantic wrappers in final templates", async () => {
    const outerTags: Record<string, string> = {
      "persona.agents": "agent_rules",
      "persona.soul": "soul",
      "persona.preference": "preference",
      "persona.dialogue_style_examples": "dialogue_style_examples",
      "persona.user": "user_context",
      "persona.relation": "relation",
      "persona.air": "air_knowledge"
    };
    for (const definition of PROMPT_FILE_DEFINITIONS.filter((item) => item.kind === "fragment")) {
      const content = await fs.readFile(path.join(workspace, definition.fileName(config)), "utf8");
      expect(() => validatePromptFragment(content), definition.id).not.toThrow();
      expect(content.trim().startsWith(`<${outerTags[definition.id]}>`), definition.id).toBe(false);
    }

    const conversation = parseFinalPromptTemplate(
      await fs.readFile(path.join(systemWorkspace, "conversation_private_reply.json"), "utf8")
    );
    const system = conversation.messages[0] as Record<string, unknown>;
    for (const [id, tag] of Object.entries(outerTags).filter(([id]) => id !== "persona.air")) {
      expect(system.content).toContain(`<${tag}>@{${id}}</${tag}>`);
    }
    const user = conversation.messages.at(-1) as Record<string, unknown>;
    expect(user.content).toContain("<air_knowledge>@{persona.air}</air_knowledge>");
  });
});

async function readFragments() {
  const entries = await Promise.all(
    PROMPT_FILE_DEFINITIONS
      .filter((item) => item.kind === "fragment")
      .map(async (definition) => [
        definition.id,
        await fs.readFile(path.join(workspace, definition.fileName(config)), "utf8")
      ] as const)
  );
  return Object.fromEntries(entries);
}
