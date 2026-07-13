import { describe, expect, it } from "vitest";
import { authenticatedMediaPath } from "./useAdminApi";

describe("authenticatedMediaPath", () => {
  it("keeps protected local media paths", () => {
    expect(authenticatedMediaPath("/generated-images/example.png")).toBe("/generated-images/example.png");
    expect(authenticatedMediaPath("/api/files/example.png")).toBe("/api/files/example.png");
  });

  it("keeps inline and browser-local media paths", () => {
    expect(authenticatedMediaPath("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(authenticatedMediaPath("blob:http://127.0.0.1/example")).toBe("blob:http://127.0.0.1/example");
  });

  it("routes remote media through the authenticated local proxy", () => {
    expect(authenticatedMediaPath("https://q1.qlogo.cn/g?b=qq&nk=42&s=100"))
      .toBe("/api/media/image?url=https%3A%2F%2Fq1.qlogo.cn%2Fg%3Fb%3Dqq%26nk%3D42%26s%3D100");
  });
});
