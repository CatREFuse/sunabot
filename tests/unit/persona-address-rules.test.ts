// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildConversationPromptVariables
} from "../../services/agent/persona.js";
import {
  renderFinalPromptTemplate,
  type FinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import { defaultConfig } from "../../src/config.js";

describe("conversation address rules", () => {
  it("renders optional profile updates through the existing editable tool-rules variable", () => {
    const request = renderFinalPromptTemplate({
      messages: [{ role: "system", content: "<tool_rules>@{runtime.tool_rules}</tool_rules>" }],
      response_format: { type: "text" }
    }, buildConversationPromptVariables(defaultConfig()));
    expect(request.messages[0]?.content).toContain("add_user_profile");
    expect(request.messages[0]?.content).toContain("没有新增或修正时可 skip 或不调用");
    expect(request.messages[0]?.content).toContain("工作记忆与 read_air 不会代替画像更新");
  });

  it("puts first-address-name priority in the Provider-facing system message", () => {
    const variables = buildConversationPromptVariables(defaultConfig());
    const template: FinalPromptTemplate = {
      messages: [
        {
          role: "system",
          content: "<address_rules>@{runtime.address_rules}</address_rules>"
        },
        {
          role: "user",
          content: "测试"
        }
      ],
      response_format: { type: "text" }
    };

    const request = renderFinalPromptTemplate(template, variables);
    const systemMessage = request.messages.find((message) => message.role === "system")?.content;

    expect(systemMessage).toContain("多个称呼");
    expect(systemMessage).toContain("第一个称呼");
    expect(systemMessage).toContain("优先");
  });
});
