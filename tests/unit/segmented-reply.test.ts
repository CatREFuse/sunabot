// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  outboundAssetBubble,
  outboundMessageBubble,
  sendOutboundBubble,
  type MessagingPort,
  type OutboundConversationAssetV1,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import { parseSegmentedReplyXml } from "../../services/messaging/segmentedReply.js";
import { renderFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import {
  TONE_AVAILABLE_ASSETS_VARIABLE,
  TONE_MODE_VARIABLE,
  TONE_OUTPUT_CONTRACT_VARIABLE,
  TONE_XML_REVIEW_RULE,
  PLAIN_TONE_OUTPUT_CONTRACT,
  segmentedToneOutputContract
} from "../../services/agent/toneReplyPrompt.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import {
  TONE_EMOJI_MARKER_RULE
} from "../../services/agent/promptWorkspace.js";
import {
  TONE_MESSAGE_PACKAGE_RULE,
  migrateToneSegmentedReplyTemplate
} from "../../services/agent/tonePromptMigration.js";

describe("segmented reply XML", () => {
  it("parses every supported bubble type in source order", () => {
    expect(parseSegmentedReplyXml([
      '<dialogc replay="msg_id">老师&amp;同学！</dialogc>',
      "<dialog>阿罗娜一直在等你！</dialog>",
      "<exp>[/开心]</exp>",
      '<exp key="[/认真]"/>',
      '<img src="asset:image:0"/>',
      '<voice src="asset:voice:0"/>',
      '<file src="asset:file:0"/>'
    ].join("\n"))).toEqual({
      schemaVersion: 1,
      nodes: [
        { type: "dialog", text: "老师&同学！", reply: true },
        { type: "dialog", text: "阿罗娜一直在等你！", reply: false },
        { type: "expression", marker: "[/开心]" },
        { type: "expression", marker: "[/认真]" },
        { type: "image", src: "asset:image:0" },
        { type: "voice", src: "asset:voice:0" },
        { type: "file", src: "asset:file:0" }
      ]
    });
  });

  it.each([
    ["plain text", "标签外文本"],
    ["<dialog>未闭合", "缺少闭合标签"],
    ["<dialog><exp>[/开心]</exp></dialog>", "不能嵌套"],
    ["<dialog>命令：<br/>npm run check</dialog>", "不能嵌套"],
    ['<dialogc replay="other">回复</dialogc>', 'replay="msg_id"'],
    ['<img src="a" alt="b"/>', "只能包含 src"],
    ["<exp>开心</exp>", "表情标记"],
    ["<exp/>", "只能包含 key"],
    ['<exp key="开心"/>', "必须是一个表情标记"],
    ['<exp key="[/开心]" extra="1"/>', "只能包含 key"],
    ["<dialog>老师&同学</dialog>", "未转义"],
    ["<dialog>老师&unknown;</dialog>", "未知实体"],
    ["<dialog>第一条</dialog><dialogc replay=\"msg_id\">第二条</dialogc>", "第一个气泡"]
  ])("rejects malformed or ambiguous XML: %s", (xml, message) => {
    expect(() => parseSegmentedReplyXml(xml)).toThrow(message);
  });
});

describe("outbound bubble protocol", () => {
  it("routes legacy messages and image/voice/file assets through one package dispatcher", async () => {
    const send = vi.fn(async () => ({ accepted: true as const, messageId: "message-1" }));
    const sendConversationAsset = vi.fn(async () => ({ accepted: true as const, messageId: "asset-1" }));
    const port = { send, sendConversationAsset } as unknown as MessagingPort;
    const message = {
      schemaVersion: 1,
      id: "m1",
      conversationId: "private:1",
      scope: "private",
      userId: 1,
      text: "旧回复",
      media: []
    } satisfies OutboundMessageV1;
    await expect(sendOutboundBubble(port, outboundMessageBubble(message))).resolves.toMatchObject({ messageId: "message-1" });
    const assets = (["image", "voice", "file"] as const).map((kind) => ({
      accountId: "primary",
      scope: "private" as const,
      userId: 1,
      asset: { kind, name: `${kind}.bin`, source: "base64://AA==", byteLength: 1 }
    } satisfies OutboundConversationAssetV1));
    for (const asset of assets) {
      await expect(sendOutboundBubble(port, outboundAssetBubble(asset))).resolves.toMatchObject({ messageId: "asset-1" });
    }
    expect(send).toHaveBeenCalledWith(message);
    expect(sendConversationAsset.mock.calls.map(([asset]) => asset.asset.kind)).toEqual(["image", "voice", "file"]);
  });
});

describe("tone segmented output prompt", () => {
  it("uses only exact allowed emoji markers and forbids expression nodes for an empty list", () => {
    const exact = segmentedToneOutputContract(["[/开心]"]);
    const empty = segmentedToneOutputContract([]);

    expect(exact).toContain('依次为 ["[/开心]"]');
    expect(exact).toContain("只能逐字使用该列表中的值");
    expect(exact).toContain('<exp key="[/key]"/>');
    expect(exact).toContain("最后一个文字气泡内");
    expect(exact).toContain("绝对不可嵌套");
    expect(exact).toContain("<br/>");
    expect(exact).toContain("不得使用规定之外的任何 XML 或 HTML 标签");
    expect(empty).toContain("列表为空时不得输出 <exp>");
  });

  it("registers both runtime variables and references them in the default template", () => {
    const variables = promptDefinitionById("conversation.tone-rewrite")?.variables.map((item) => item.name);
    expect(variables).toEqual(expect.arrayContaining([
      TONE_MODE_VARIABLE,
      TONE_OUTPUT_CONTRACT_VARIABLE,
      TONE_AVAILABLE_ASSETS_VARIABLE
    ]));
    const serialized = JSON.stringify(defaultFinalPromptTemplate("conversation.tone-rewrite"));
    expect(serialized).toContain(`s-if=\\\"${TONE_MODE_VARIABLE} == true\\\"`);
    expect(serialized).toContain(`@{${TONE_OUTPUT_CONTRACT_VARIABLE}}`);
    expect(serialized).toContain(`@{${TONE_AVAILABLE_ASSETS_VARIABLE}}`);
  });

  it("injects XML review rules only for segmented Tone requests", () => {
    const template = defaultFinalPromptTemplate("conversation.tone-rewrite");
    if (!template) throw new Error("missing tone template");
    const variables = {
      "persona.agents": "规则",
      "persona.soul": "人格",
      "persona.preference": "偏好",
      "persona.dialogue_style_examples": "示例",
      "persona.user": "用户",
      "persona.relation": "关系",
      "persona.air": "场域",
      "runtime.current_time": "2026-07-21T00:00:00+08:00",
      "tone.input": "原文",
      [TONE_AVAILABLE_ASSETS_VARIABLE]: "[]"
    };
    const plain = renderFinalPromptTemplate(template, {
      ...variables,
      [TONE_MODE_VARIABLE]: false,
      [TONE_OUTPUT_CONTRACT_VARIABLE]: PLAIN_TONE_OUTPUT_CONTRACT
    });
    expect(JSON.stringify(plain.messages)).not.toContain("<xml-check");
    expect(JSON.stringify(plain.messages)).not.toContain("XML 草稿会原样进入 Tone");

    const segmented = renderFinalPromptTemplate(template, {
      ...variables,
      [TONE_MODE_VARIABLE]: true,
      [TONE_OUTPUT_CONTRACT_VARIABLE]: segmentedToneOutputContract([])
    });
    expect(JSON.stringify(segmented.messages)).toContain("<xml-check>");
    expect(JSON.stringify(segmented.messages)).toContain("XML 草稿会原样进入 Tone");
    expect(JSON.stringify(segmented.messages)).toContain("信息较短时，可以按短句拆分");
    expect(JSON.stringify(segmented.messages)).toContain("信息较长时，每个文字气泡承载一个完整段落");
    expect(JSON.stringify(segmented.messages)).toContain("文字气泡总数不超过 3 个");
    expect(JSON.stringify(segmented.messages)).toContain("用户明确要求只用一个气泡时");
    expect(JSON.stringify(segmented.messages)).not.toContain("s-if=");
  });

  it("migrates old tone templates once without reordering existing messages", () => {
    const original = {
      messages: [
        { role: "system", content: `自定义规则\n\n${TONE_EMOJI_MARKER_RULE}` },
        { role: "user", content: "<original>@{tone.input}</original>" }
      ],
      tools: [],
      response_format: { type: "text" }
    } as const;
    const migrated = migrateToneSegmentedReplyTemplate(original as never);
    expect(migrated.messages[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(migrated)).toContain(TONE_MESSAGE_PACKAGE_RULE);
    expect((migrated.messages[0] as { content: string }).content).toContain(TONE_XML_REVIEW_RULE);
    expect(JSON.stringify(migrated)).toContain(`@{${TONE_OUTPUT_CONTRACT_VARIABLE}}`);
    expect(JSON.stringify(migrated)).toContain(`@{${TONE_AVAILABLE_ASSETS_VARIABLE}}`);
    expect(migrated.messages.at(-1)).toEqual(original.messages.at(-1));
    expect(migrateToneSegmentedReplyTemplate(migrated)).toBe(migrated);
  });
});
