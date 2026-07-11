import { describe, expect, it } from "vitest";
import { imageDownloadName } from "./useImageStudio";

describe("imageDownloadName", () => {
  it("uses and sanitizes a stored filename", () => {
    expect(imageDownloadName({ id: "1", url: "/generated-images/a.png", filePath: "/tmp/危险 image.png", createdAt: "" }, "image/png"))
      .toBe("image.png");
  });

  it("adds a MIME extension to a stable fallback name", () => {
    expect(imageDownloadName({ id: "history 7", url: "", createdAt: "" }, "image/webp"))
      .toBe("sunabot-image-history-7.webp");
  });
});
