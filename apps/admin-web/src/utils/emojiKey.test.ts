import { describe, expect, it } from "vitest";
import { emojiKeyValidationError, normalizeEmojiKey } from "./emojiKey";

describe("emoji key validation", () => {
  it("normalizes harmless surrounding spaces and NFC text", () => {
    expect(normalizeEmojiKey("  e\u0301  ")).toBe("é");
    expect(emojiKeyValidationError("  开心  ")).toBe("");
  });

  it("rejects controls and invalid Unicode before trimming", () => {
    expect(emojiKeyValidationError("\t开心")).toBe("表情名称不能包含括号、斜杠或控制字符");
    expect(emojiKeyValidationError("开心\n")).toBe("表情名称不能包含括号、斜杠或控制字符");
    expect(emojiKeyValidationError("开\u0085心")).toBe("表情名称不能包含括号、斜杠或控制字符");
    expect(emojiKeyValidationError("\ud800")).toBe("表情名称包含无效字符");
  });
});
