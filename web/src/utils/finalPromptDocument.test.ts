import { describe, expect, it } from "vitest";
import { validateFinalPromptDocument } from "./finalPromptDocument";

const variables = [
  { name: "messages_64", description: "最近 64 条消息", type: "message[]" as const, source: "会话", required: true },
  { name: "user.input", description: "当前输入", type: "string" as const, source: "请求", required: true }
];

function template(messages: unknown[], tools: unknown[] = []) {
  return JSON.stringify({ messages, tools, response_format: { type: "text" } });
}

describe("final prompt document validation", () => {
  it("accepts ordered messages mixed with a message group", () => {
    const result = validateFinalPromptDocument(template([
      { role: "system", content: "系统" },
      "@{messages_64}",
      { role: "user", content: "@{user.input}" }
    ]), variables);

    expect(result).toEqual({ valid: true, message: "符合 OpenAI 请求结构" });
  });

  it("requires message groups to reference message array variables", () => {
    expect(validateFinalPromptDocument(template([
      { role: "system", content: "系统" },
      "@{user.input}",
      { role: "user", content: "用户" }
    ]), variables)).toMatchObject({ valid: false, message: expect.stringContaining("message[]") });
  });

  it("rejects invalid roles and duplicate Function names", () => {
    expect(validateFinalPromptDocument(template([
      { role: "invalid", content: "系统" },
      { role: "user", content: "用户" }
    ]), variables)).toMatchObject({ valid: false, message: expect.stringContaining("role") });

    const duplicate = {
      type: "function",
      function: { name: "search", description: "搜索", parameters: { type: "object" } }
    };
    expect(validateFinalPromptDocument(template([
      { role: "system", content: "系统" },
      { role: "user", content: "用户" }
    ], [duplicate, duplicate]), variables)).toMatchObject({ valid: false, message: expect.stringContaining("重复") });
  });
});
