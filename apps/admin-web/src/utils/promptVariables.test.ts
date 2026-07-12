import { describe, expect, it } from "vitest";
import { usedPromptVariableNames } from "./promptVariables";

describe("usedPromptVariableNames", () => {
  it("recognizes both supported prompt variable syntaxes", () => {
    const variables = [
      { name: "persona.soul", description: "人格", type: "string" as const, source: "SOUL.md", required: true },
      { name: "memory.working", description: "工作记忆", type: "string" as const, source: "记忆", required: true }
    ];

    expect(usedPromptVariableNames("{{ persona.soul }}\n@{memory.working}", variables))
      .toEqual(["persona.soul", "memory.working"]);
  });
});
