import { describe, expect, it } from "vitest";
import { displayMessageText } from "./messageText";

describe("displayMessageText", () => {
  it("hides the pure image placeholder but keeps real captions", () => {
    expect(displayMessageText("[图片]", ["https://example.com/image.png"], {})).toBe("");
    expect(displayMessageText("看看这张图", ["https://example.com/image.png"], {})).toBe("看看这张图");
    expect(displayMessageText("[图片]", [], {})).toBe("[图片]");
  });

  it("renders known QQ mentions as group-card labels and keeps unknown mentions unchanged", () => {
    const text = "@1309367301 现在开始，@99999999 保持原样";
    expect(displayMessageText(text, [], { "1309367301": "飞行雪绒" })).toBe(
      "@飞行雪绒 (1309367301) 现在开始，@99999999 保持原样"
    );
  });
});
