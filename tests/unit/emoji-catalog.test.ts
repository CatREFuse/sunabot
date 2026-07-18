// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EMOJI_MARKER_SYNTAX,
  MAX_EMOJI_MARKERS_PER_REPLY,
  PRESET_EMOJI_KEYS,
  emojiGenerationPrompt,
  emojiPlanContainsMarkers,
  emojiPlanContainsOnlyMarkers,
  guardEmojiToneRewrite,
  isValidEmojiKey,
  planEmojiMarkers,
  prepareEmojiReply,
  restoreEmojiToneRewrite,
  type EmojiCatalogPort
} from "../../services/emojis/emojiCatalog.js";

const port: EmojiCatalogPort = {
  listAvailable: () => [
    { key: "开心", image: { url: "/generated-images/emoji-happy.png", filePath: "/media/emoji-happy.png" } },
    { key: "哭", image: { url: "/generated-images/emoji-cry.png", filePath: "/media/emoji-cry.png" } }
  ]
};

describe("emoji catalog", () => {
  it("keeps the required preset keys and validates custom marker-safe keys", () => {
    expect(PRESET_EMOJI_KEYS).toEqual([
      "开心", "哭", "抓狂", "惊慌", "害羞", "极度害羞", "困倦", "认真", "嫌弃脸", "生气", "汗颜"
    ]);
    expect(isValidEmojiKey("  好耶  ")).toBe(true);
    expect(isValidEmojiKey("bad/key")).toBe(false);
    expect(isValidEmojiKey("[坏]")).toBe(false);
    expect(isValidEmojiKey("a".repeat(25))).toBe(false);
    expect(isValidEmojiKey("表".repeat(22))).toBe(false);
    expect(isValidEmojiKey("换\n行")).toBe(false);
    expect(isValidEmojiKey("\t开心")).toBe(false);
    expect(isValidEmojiKey("开心\r")).toBe(false);
    expect(isValidEmojiKey("开\u0085心")).toBe(false);
    expect(isValidEmojiKey("\ud800")).toBe(false);
    expect(isValidEmojiKey("\udc00")).toBe(false);
    expect(isValidEmojiKey("\ufffd")).toBe(false);
    expect(isValidEmojiKey("😀")).toBe(true);
    expect(MAX_EMOJI_MARKERS_PER_REPLY).toBe(4);
    expect(EMOJI_MARKER_SYNTAX).toContain("单条回复最多 4 个表情");
  });

  it("caps known markers at four while ignoring unknown and escaped marker-like text", () => {
    const accepted = planEmojiMarkers(
      `正文${"[/开心]".repeat(4)}[/不存在]\\[/开心]`,
      port
    );

    expect(accepted.expectedMarkers).toHaveLength(4);
    expect(() => planEmojiMarkers(`正文${"[/开心]".repeat(5)}`, port))
      .toThrow("单条回复最多 4 个表情");
  });

  it("replaces known markers with ordered image segments and leaves unknown markers as text", () => {
    const plan = planEmojiMarkers("早上好[/开心]今天[/不存在]还好吗[/哭]", port);
    const prepared = prepareEmojiReply(plan.text, plan, [{ url: "/generated-images/tool.png" }]);

    expect(prepared.text).toBe("早上好今天[/不存在]还好吗");
    expect(prepared.images.map((image) => image.url)).toEqual([
      "/generated-images/emoji-happy.png",
      "/generated-images/emoji-cry.png",
      "/generated-images/tool.png"
    ]);
    expect(prepared.contentSegments).toEqual([
      { type: "text", text: "早上好" },
      { type: "image", imageIndex: 0 },
      { type: "text", text: "今天[/不存在]还好吗" },
      { type: "image", imageIndex: 1 },
      { type: "image", imageIndex: 2 }
    ]);
  });

  it("skips tone for marker-only replies and fails closed when tone changes marker order", () => {
    const markerOnly = planEmojiMarkers("[/开心] [/哭]", port);
    expect(emojiPlanContainsOnlyMarkers(markerOnly)).toBe(true);
    expect(prepareEmojiReply(markerOnly.text, markerOnly).text).toBe("");
    expect(() => prepareEmojiReply("[/哭] [/开心]", markerOnly)).toThrow("改变了表情标记");
    expect(() => prepareEmojiReply("[/开心]", markerOnly)).toThrow("改变了表情标记");
  });

  it("keeps exact marker tokens and their relative text-segment skeleton", () => {
    const plan = planEmojiMarkers("前[/开心]后", port);
    const guard = guardEmojiToneRewrite(plan.text, plan);
    const rewritten = restoreEmojiToneRewrite(
      guard.input.replace("前", "您好").replace("后", "呀"),
      guard
    );
    expect(emojiPlanContainsMarkers(plan)).toBe(true);
    expect(prepareEmojiReply(rewritten.text, rewritten.plan).contentSegments).toEqual([
      { type: "text", text: "您好" },
      { type: "image", imageIndex: 0 },
      { type: "text", text: "呀" }
    ]);
    expect(() => prepareEmojiReply("前后[/开心]", plan)).toThrow("改变了表情标记");
    expect(() => prepareEmojiReply("前[/开心]乙后", plan)).toThrow("改变了表情标记");
    const internalMove = planEmojiMarkers("甲乙[/开心]丙丁", port);
    expect(() => prepareEmojiReply("甲[/开心]乙丙丁", internalMove)).toThrow("改变了表情标记");
    expect(() => prepareEmojiReply("前[/开心 ]后", plan)).toThrow("改变了表情标记");
  });

  it("preserves escaped and whitespace-padded marker examples as literal text", () => {
    const escaped = planEmojiMarkers("示例 \\[/开心]", port);
    const padded = planEmojiMarkers("示例 [/ 开心 ]", port);

    expect(emojiPlanContainsMarkers(escaped)).toBe(false);
    expect(prepareEmojiReply(escaped.text, escaped)).toEqual({ text: "示例 \\[/开心]", images: [] });
    expect(emojiPlanContainsMarkers(padded)).toBe(false);
    expect(prepareEmojiReply(padded.text, padded)).toEqual({ text: "示例 [/ 开心 ]", images: [] });
  });

  it("builds a square large-head generation prompt without visible text", () => {
    const prompt = emojiGenerationPrompt("害羞", "小春");
    expect(prompt).toContain("小春");
    expect(prompt).toContain("1:1 方形构图");
    expect(prompt).toContain("大头及肩部近景");
    expect(prompt).toContain("不要文字");
  });
});
