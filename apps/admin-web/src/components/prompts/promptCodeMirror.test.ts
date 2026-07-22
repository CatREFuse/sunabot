import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  createPromptVariableCompletionSource,
  promptVariableToken
} from "./promptCodeMirror";

const variables = [
  {
    name: "user.input",
    description: "当前用户输入",
    type: "string" as const,
    source: "当前请求",
    required: true
  },
  {
    name: "persona.soul",
    description: "角色核心人格",
    type: "string" as const,
    source: "SOUL.md",
    required: true
  }
];

describe("promptCodeMirror", () => {
  it("searches variable completions by annotation", async () => {
    const state = EditorState.create({ doc: "@用户" });
    const source = createPromptVariableCompletionSource(variables, false);
    const result = await source(new CompletionContext(state, state.doc.length, false));

    expect(result?.from).toBe(0);
    expect(result?.options).toHaveLength(1);
    expect(result?.options[0]?.label).toBe("@{user.input}");
    expect(result?.options[0]?.apply).toBe("@{user.input}");
  });

  it("wraps completion values in semantic XML when requested", async () => {
    const state = EditorState.create({ doc: "@persona" });
    const source = createPromptVariableCompletionSource(variables, true);
    const result = await source(new CompletionContext(state, state.doc.length, false));

    expect(result?.options[0]?.apply).toBe("<persona_soul>@{persona.soul}</persona_soul>");
  });

  it("does not reopen completion after a closed variable reference", async () => {
    const state = EditorState.create({ doc: "@{user.input}" });
    const source = createPromptVariableCompletionSource(variables, false);

    expect(await source(new CompletionContext(state, state.doc.length, false))).toBeNull();
  });

  it("normalizes semantic XML tag names", () => {
    expect(promptVariableToken("9 bad.name", true)).toBe(
      "<variable_9_bad_name>@{9 bad.name}</variable_9_bad_name>"
    );
  });
});
