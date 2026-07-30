// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_CONTEXT_CONTRACT,
  defaultFinalPromptTemplate
} from "../../services/agent/promptDefaults.js";
import { PROMPT_FILE_DEFINITIONS } from "../../services/agent/promptCatalog.js";
import {
  migrateGroupReplyTopicReasoning,
  migrateGroupReplyTopicReasoningTemplate
} from "../../services/agent/groupReplyTopicReasoningMigration.js";
import { renderFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { defaultConfig } from "../../src/config.js";
import { currentPromptInputMessage } from "../../src/runtime/promptRequestHelpers.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

describe("group reply topic reasoning", () => {
  it("keeps topic reasoning inside the main group reply contract", () => {
    const template = defaultFinalPromptTemplate("conversation.group-reply")!;
    const system = template.messages.find((message) => (
      typeof message === "object" && message.role === "system"
    ));
    expect(system).toBeTruthy();
    expect(String(typeof system === "string" ? system : system?.content)).toContain(
      `<group_context_contract>${DEFAULT_GROUP_CONTEXT_CONTRACT}</group_context_contract>`
    );
    expect(DEFAULT_GROUP_CONTEXT_CONTRACT).toContain("<internal_topic_reasoning>");
    expect(DEFAULT_GROUP_CONTEXT_CONTRACT).toContain("在内部按 messages_64 的原始顺序梳理并行话题");
    expect(DEFAULT_GROUP_CONTEXT_CONTRACT).toContain("不得输出话题划分过程、内部推理");
  });

  it("has no independent topic-classifier prompt or dynamic sidecar variable", () => {
    const ids = PROMPT_FILE_DEFINITIONS.map((definition) => definition.id);
    expect(ids).not.toContain("orchestrator.group-thread");
    const group = PROMPT_FILE_DEFINITIONS.find((definition) => (
      definition.id === "conversation.group-reply"
    ))!;
    expect(group.variables.map((variable) => variable.name))
      .not.toContain("conversation.group.thread_context");
    expect(defaultFinalPromptTemplate("orchestrator.group-thread")).toBeUndefined();
  });

  it("renders history, orchestrator result and current input without a sidecar request", () => {
    const request = renderFinalPromptTemplate(
      defaultFinalPromptTemplate("conversation.group-reply")!,
      {
        "persona.agents": "",
        "persona.soul": "",
        "persona.preference": "",
        "persona.dialogue_style_examples": "",
        "persona.user": "",
        "persona.relation": "",
        "runtime.output_rules": "",
        "runtime.address_rules": "",
        "runtime.scope_rules": "",
        "runtime.tool_rules": "",
        "conversation.emoji.keys": "[]",
        "conversation.emoji.syntax": "",
        "conversation.voice.settings": "{}",
        "conversation.voice.trigger_policy": "",
        "conversation.director.schedule": "",
        "conversation.group.orchestrator_result": "",
        "persona.air": "",
        "memory.working": "",
        "memory.long_term": "",
        "memory.user_profile": "",
        "runtime.current_time": "2026-07-30T12:00:00+08:00",
        "utils.roll": 50,
        "messages_64": [{ role: "assistant", content: "历史回复" }],
        "user.input": "当前输入"
      }
    );
    const historyIndex = request.messages.findIndex((message) => message.content === "历史回复");
    const orchestratorIndex = request.messages.findIndex((message) => (
      message.content.includes("<orchestrator_result>")
    ));
    const inputIndex = request.messages.findIndex((message) => (
      message.role === "user" && message.content.includes("<current_input>当前输入</current_input>")
    ));
    expect(historyIndex).toBeGreaterThanOrEqual(0);
    expect(orchestratorIndex).toBeGreaterThan(historyIndex);
    expect(inputIndex).toBeGreaterThan(orchestratorIndex);
  });

  it("removes the retired sidecar block and updates a custom group contract", () => {
    const template = {
      messages: [
        { role: "system" as const, content: "管理员开头\n\n<group_context_contract>旧合同</group_context_contract>" },
        "@{messages_64}",
        { role: "developer" as const, content: "<thread_context>@{conversation.group.thread_context}</thread_context>" },
        { role: "user" as const, content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" as const }
    };
    const migrated = migrateGroupReplyTopicReasoningTemplate(template);
    expect(migrated.messages).toHaveLength(3);
    expect(JSON.stringify(migrated)).toContain("<internal_topic_reasoning>");
    expect(JSON.stringify(migrated)).not.toContain("conversation.group.thread_context");
    expect(migrated.messages[0]).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("管理员开头")
    }));
  });

  it("persists the group topic reasoning migration once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-group-topic-"));
    temporaryRoots.push(root);
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = root;
    const fileName = "group.json";
    await fs.writeFile(path.join(root, fileName), JSON.stringify({
      messages: [
        { role: "system", content: "管理员开头" },
        "@{messages_64}",
        { role: "user", content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    }));
    await expect(migrateGroupReplyTopicReasoning(config, fileName)).resolves.toBe(true);
    await expect(migrateGroupReplyTopicReasoning(config, fileName)).resolves.toBe(false);
    const migrated = await fs.readFile(path.join(root, fileName), "utf8");
    expect(migrated).toContain("<internal_topic_reasoning>");
  });

  it("finds and clears the temporary current-input marker", () => {
    const marker = { start: "<start>", end: "<end>" };
    const request = {
      messages: [
        { role: "user" as const, content: "历史" },
        { role: "user" as const, content: `前缀${marker.start}当前${marker.end}` }
      ],
      tools: [],
      response_format: { type: "text" as const }
    };
    const current = currentPromptInputMessage(request, marker);
    expect(current?.content).toBe("前缀当前");
    expect(request.messages.every((message) => (
      !message.content.includes(marker.start) && !message.content.includes(marker.end)
    ))).toBe(true);
  });
});
