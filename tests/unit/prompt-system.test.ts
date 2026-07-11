// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  validatePromptFragment
} from "../../services/agent/promptSystem.js";

describe("prompt system", () => {
  it("renders both variable syntaxes and wraps raw prompt fragments in the final template", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      messages: [
        { role: "system", content: "<soul>@{persona.soul}</soul>\n{{runtime.rules}}" },
        "@{conversation.messages}",
        { role: "user", content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    }));

    const rendered = renderFinalPromptTemplate(template, {
      "persona.soul": "称呼 @{address.name}",
      "address.name": "老师",
      "runtime.rules": "只输出正文。",
      "conversation.messages": [{ role: "assistant", content: "历史回复" }],
      "user.input": "现在几点？"
    });

    expect(rendered.messages).toEqual([
      { role: "system", content: "<soul>称呼 老师</soul>\n只输出正文。" },
      { role: "assistant", content: "历史回复" },
      { role: "user", content: "现在几点？" }
    ]);
  });

  it("keeps arbitrary OpenAI fields while rendering JSON values", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "系统" },
        { role: "user", content: "@{payload}" }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    }));

    const rendered = renderFinalPromptTemplate(template, { payload: { id: 7 } });

    expect(rendered).toMatchObject({
      model: "gpt-5.5",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: "系统" }, { role: "user", content: '{\n  "id": 7\n}' }]
    });
  });

  it("rejects missing variables, cycles and malformed templates", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      messages: [{ role: "system", content: "@{a}" }, { role: "user", content: "用户" }],
      response_format: { type: "text" }
    }));

    expect(() => renderFinalPromptTemplate(template, {})).toThrowError(/缺少变量：a/);
    expect(() => renderFinalPromptTemplate(template, { a: "@{b}", b: "{{a}}" })).toThrowError(/循环引用/);
    expect(() => parseFinalPromptTemplate('{"messages":[]}')).toThrowError(/非空 messages/);
  });

  it("accepts raw MD fragments without an outer XML wrapper", () => {
    expect(() => validatePromptFragment("# 角色设定\n\n保持冷静。")).not.toThrow();
    expect(() => validatePromptFragment("<voice>内部结构化内容</voice>")).not.toThrow();
  });

  it("extracts unique variables in source order", () => {
    expect(extractPromptVariables("@{first}\n{{ second }}\n@{first}")).toEqual(["first", "second"]);
  });
});
