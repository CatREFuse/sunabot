import { describe, expect, it } from "vitest";
import { conversationIdentityDetail, qqAvatarUrl, qqGroupAvatarUrl } from "./qqIdentity";

describe("QQ avatar routes", () => {
  it("uses the dedicated QQ avatar proxy for users and groups", () => {
    expect(qqAvatarUrl(171419991)).toBe("/api/media/qq-avatar?kind=user&id=171419991");
    expect(qqGroupAvatarUrl(1030412235)).toBe("/api/media/qq-avatar?kind=group&id=1030412235");
  });

  it("does not create an avatar route without a valid numeric id", () => {
    expect(qqAvatarUrl(undefined)).toBe("");
    expect(qqGroupAvatarUrl("not-a-group")).toBe("");
  });

  it("keeps readable names primary and identifiers secondary", () => {
    expect(conversationIdentityDetail({
      id: "private:171419991",
      scope: "private",
      title: "猫老师",
      nickname: "好吃的猫头菇",
      remark: "猫老师",
      userId: 171419991,
      messageCount: 1,
      lastAt: "",
      lastText: "",
      messages: []
    })).toBe("QQ 昵称 好吃的猫头菇 · QQ 171419991");
  });
});
