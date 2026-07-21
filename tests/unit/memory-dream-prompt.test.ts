// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_PAYLOAD_VARIABLE,
  DREAM_PROMPT_FILE,
  DREAM_PROMPT_ID,
  dreamPromptTemplate
} from "../../services/memory/dream/public.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import { responseFormatFields } from "../../adapters/model/provider/promptMapping.js";

describe("Dream prompt", () => {
  it("uses a strict editable final-prompt contract with an opaque payload", () => {
    expect(DREAM_PROMPT_ID).toBe("memory.dream");
    expect(DREAM_PROMPT_FILE).toBe("memory_dream.json");
    const template = parseFinalPromptTemplate(JSON.stringify(dreamPromptTemplate()));
    const rendered = renderFinalPromptTemplate(template, {
      "runtime.current_time": "2026-07-20 04:00:00 +08:00 [Asia/Shanghai]",
      "persona.soul": "冷静而温和",
      "persona.preference": "重视清晰和承诺",
      "persona.user": "尊重已确认的称呼",
      "persona.relation": "谨慎维护长期关系",
      [DREAM_PAYLOAD_VARIABLE]: {
        schemaVersion: 1,
        seed: "seed:fixed",
        workingMemories: [],
        longTermMemories: []
      }
    }, { opaqueVariables: [DREAM_PAYLOAD_VARIABLE] });

    expect(rendered.tools).toEqual([]);
    expect(rendered.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "memory_dream", strict: true }
    });
    expect(JSON.stringify(rendered.response_format)).not.toContain('"uniqueItems"');
    expect(JSON.stringify(responseFormatFields(rendered.response_format, undefined)))
      .not.toContain('"uniqueItems"');
    expect(rendered.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(rendered.messages[1]?.content).toContain('"seed": "seed:fixed"');
  });

  it("injects the selected memories once as one batch and bounds every review array to 24", () => {
    const template = dreamPromptTemplate();
    const messages = JSON.stringify(template.messages);
    expect(messages.split(`@{${DREAM_PAYLOAD_VARIABLE}}`)).toHaveLength(2);
    expect(template.messages[0]?.content).toContain("本轮唯一的记忆压缩批次");
    const schema = template.response_format.json_schema.schema;
    expect(schema.properties.longTermReviews.maxItems).toBe(24);
    expect(schema.properties.workingReviews.maxItems).toBe(24);
  });
});
