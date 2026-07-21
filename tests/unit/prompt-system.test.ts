// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  renderedPromptUsesVariable,
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
    expect(renderedPromptUsesVariable(rendered, "payload")).toBe(true);
    expect(renderedPromptUsesVariable(rendered, "unused")).toBe(false);
  });

  it("keeps opaque runtime message and user values byte-for-byte instead of resolving their tokens", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      messages: [
        { role: "system", content: "系统" },
        "@{messages_64}",
        { role: "user", content: "@{user.input}" }
      ],
      response_format: { type: "text" }
    }));
    const rawHistory = "正文 @{bot.name} @{messages_64} @{conversation.group.thread_context}";
    const rawInput = "当前输入 @{bot.name}";

    const rendered = renderFinalPromptTemplate(template, {
      messages_64: [{ role: "user", content: rawHistory }],
      "user.input": rawInput,
      "bot.name": "普拉娜",
      "conversation.group.thread_context": ""
    }, { opaqueVariables: new Set(["messages_64", "user.input"]) });

    expect(rendered.messages[1]?.content).toBe(rawHistory);
    expect(rendered.messages[2]?.content).toBe(rawInput);
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
    expect(extractPromptVariables([
      "@{first}",
      '<xml-check s-if="tone_mode == true && feature.enabled">{{ second }}</xml-check>',
      "@{first}"
    ].join("\n"))).toEqual(["first", "second", "tone_mode", "feature.enabled"]);
    expect(extractPromptVariables(JSON.stringify({
      messages: [{
        role: "system",
        content: '<xml-check s-if="tone_mode == true">@{rule}</xml-check>'
      }]
    }))).toEqual(["rule", "tone_mode"]);
  });

  it("renders safe s-if expressions before resolving variables inside the block", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      messages: [
        {
          role: "system",
          content: [
            "固定规则",
            '<xml-check s-if="tone_mode == true && (mode === \'segmented\' || retries >= 2)">检查 @{xml.rule}</xml-check>'
          ].join("\n")
        },
        { role: "user", content: "用户" }
      ],
      response_format: { type: "text" }
    }));

    const enabled = renderFinalPromptTemplate(template, {
      tone_mode: true,
      mode: "segmented",
      retries: 0,
      "xml.rule": "只允许顶层节点。"
    });
    expect(enabled.messages[0]?.content).toBe("固定规则\n<xml-check>检查 只允许顶层节点。</xml-check>");
    expect(renderedPromptUsesVariable(enabled, "tone_mode")).toBe(true);

    const disabled = renderFinalPromptTemplate(template, {
      tone_mode: false,
      mode: "segmented",
      retries: 0
    });
    expect(disabled.messages[0]?.content).toBe("固定规则\n");
    expect(renderedPromptUsesVariable(disabled, "xml.rule")).toBe(false);
  });

  it("rejects executable or unclosed s-if syntax when a prompt is validated", () => {
    expect(() => validatePromptFragment('<rule s-if="check()">内容</rule>')).toThrowError(/s-if/);
    expect(() => validatePromptFragment('<rule s-if="tone_mode = true">内容</rule>')).toThrowError(/s-if/);
    expect(() => validatePromptFragment('<rule s-if="tone_mode" s-if="enabled">内容</rule>')).toThrowError(/只能包含一个 s-if/);
    expect(() => validatePromptFragment('<rule s-if="tone_mode == true">内容')).toThrowError(/闭合标签/);
    expect(() => parseFinalPromptTemplate(JSON.stringify({
      messages: [{ role: "system", content: "系统" }, { role: "user", content: "用户" }],
      tools: [{
        type: "function",
        function: {
          name: "invalid",
          description: '<rule s-if="check()">非法</rule>',
          parameters: { type: "object" }
        }
      }],
      response_format: { type: "text" }
    }))).toThrowError(/s-if/);
  });

  it("renders nested s-if blocks and rejects missing or non-boolean condition values", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      messages: [
        {
          role: "system",
          content: '<outer s-if="outer"><inner s-if="inner">内容</inner></outer>'
        },
        { role: "user", content: "用户" }
      ],
      response_format: { type: "text" }
    }));

    expect(renderFinalPromptTemplate(template, { outer: true, inner: false }).messages[0]?.content)
      .toBe("<outer></outer>");
    expect(() => renderFinalPromptTemplate(template, { outer: true })).toThrowError(/缺少变量：inner/);
    expect(() => renderFinalPromptTemplate(template, { outer: "yes", inner: true })).toThrowError(/最终结果必须是 boolean/);
  });

  it("does not execute s-if markup supplied through an opaque variable", () => {
    const template = parseFinalPromptTemplate(JSON.stringify({
      messages: [
        { role: "system", content: "系统" },
        { role: "user", content: "<input>@{user.input}</input>" }
      ],
      response_format: { type: "text" }
    }));
    const raw = '<rule s-if="missing == true">用户原文</rule>';
    const rendered = renderFinalPromptTemplate(template, {
      "user.input": raw
    }, { opaqueVariables: ["user.input"] });

    expect(rendered.messages[1]?.content).toBe(`<input>${raw}</input>`);
  });
});
