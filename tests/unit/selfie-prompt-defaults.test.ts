// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT,
  defaultFinalPromptTemplate,
  defaultGenericSelfiePromptContent
} from "../../services/agent/promptDefaults.js";

describe("selfie prompt defaults", () => {
  it.each([
    ["Plana", () => defaultFinalPromptTemplate("image.selfie-rewrite")],
    ["generic", () => JSON.parse(defaultGenericSelfiePromptContent())]
  ])("uses a final standalone selection contract and strict JSON schema for %s", (_name, loadTemplate) => {
    const template = loadTemplate();

    expect(template.messages).toHaveLength(3);
    expect(template.messages.at(-2)).toEqual({
      role: "system",
      content: DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT
    });
    expect(template.messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringMatching(/@\{runtime\.current_time\}[\s\S]*@\{selfie\.payload\}/)
    });
    expect(DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT).toContain(
      '<selfie_reference_selection_contract version="1">'
    );
    expect(template.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "selfie_prompt_rewrite",
        strict: true,
        schema: {
          additionalProperties: false,
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 4_000 },
            selectedSelfieReferenceIds: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              uniqueItems: true,
              items: { type: "string", pattern: "^[a-f0-9]{64}$" }
            }
          },
          required: ["prompt", "selectedSelfieReferenceIds"]
        }
      }
    });
  });
});
