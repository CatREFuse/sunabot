// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_FILE_DEFINITIONS } from "../../services/agent/promptCatalog.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  validatePromptFragment,
  type PromptVariableValue
} from "../../services/agent/promptSystem.js";
import { defaultConfig } from "../../src/config.js";

const workspace = path.join(process.cwd(), "workspace/business/agents/plana");
const config = defaultConfig();
config.persona.agentWorkspace = workspace;

describe("workspace prompt runtime", () => {
  it("parses and resolves every final request template without leftover variables", async () => {
    const fragmentValues = await readFragments();

    for (const definition of PROMPT_FILE_DEFINITIONS.filter((item) => item.kind === "final")) {
      const content = await fs.readFile(path.join(workspace, definition.fileName(config)), "utf8");
      const template = parseFinalPromptTemplate(content);
      const variables: Record<string, PromptVariableValue> = { ...fragmentValues };
      for (const variable of definition.variables) {
        if (Object.hasOwn(variables, variable.name)) continue;
        variables[variable.name] = variable.type === "message[]"
          ? [{ role: "assistant", content: "历史回复" }]
          : variable.type === "json"
            ? { fixture: definition.id }
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
    const definition = PROMPT_FILE_DEFINITIONS.find((item) => item.id === "conversation.reply")!;
    const template = parseFinalPromptTemplate(
      await fs.readFile(path.join(workspace, definition.fileName(config)), "utf8")
    );
    const rendered = renderFinalPromptTemplate(template, {
      ...await readFragments(),
      "runtime.output_rules": "只输出正文。",
      "runtime.address_rules": "称呼用户为老师。",
      "runtime.scope_rules": "识别会话范围。",
      "runtime.tool_rules": "按需调用工具。",
      "messages_64": [
        { role: "user", content: "上一条问题" },
        { role: "assistant", content: "上一条回复" }
      ],
      "user.input": "当前问题"
    });

    expect(rendered.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(rendered.messages[0]?.content).toContain("<soul>");
    expect(rendered.messages[0]?.content).toContain("<output_rules>只输出正文。</output_rules>");
    expect(rendered.messages.at(-1)?.content).toBe("当前问题");
    expect(rendered.tools?.map((tool) => tool.function.name)).toEqual([
      "workspace_bash",
      "websearch",
      "generate_img",
      "selfie",
      "memory_recall",
      "codex"
    ]);
    expect(rendered.tools?.every((tool) => tool.function.description.trim().length > 0)).toBe(true);
  });

  it("keeps reusable MD prompts raw and places their semantic wrappers in final templates", async () => {
    const outerTags: Record<string, string> = {
      "persona.agents": "agent_rules",
      "persona.soul": "soul",
      "persona.preference": "preference",
      "persona.user": "user_context",
      "persona.relation": "relation"
    };
    for (const definition of PROMPT_FILE_DEFINITIONS.filter((item) => item.kind === "fragment")) {
      const content = await fs.readFile(path.join(workspace, definition.fileName(config)), "utf8");
      expect(() => validatePromptFragment(content), definition.id).not.toThrow();
      expect(content.trim().startsWith(`<${outerTags[definition.id]}>`), definition.id).toBe(false);
    }

    const conversation = parseFinalPromptTemplate(
      await fs.readFile(path.join(workspace, "conversation_reply.json"), "utf8")
    );
    const system = conversation.messages[0] as Record<string, unknown>;
    for (const [id, tag] of Object.entries(outerTags)) {
      expect(system.content).toContain(`<${tag}>@{${id}}</${tag}>`);
    }
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
