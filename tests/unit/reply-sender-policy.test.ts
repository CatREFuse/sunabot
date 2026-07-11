// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAdminSender, isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";

describe("reply sender policy", () => {
  it("permits any valid QQ sender", () => {
    expect(isReplySenderAllowed(171419991, "171419991")).toBe(true);
    expect(isReplySenderAllowed(998877665, "171419991")).toBe(true);
  });

  it.each([undefined, "", "   ", "not-a-qq", "171419991,223344556", "1234"])(
    "does not depend on the administrator setting: %s",
    (adminQq) => {
      expect(isReplySenderAllowed(171419991, adminQq)).toBe(true);
    }
  );

  it.each(["", "not-a-qq", "1234", "171419991,223344556"])(
    "fails closed for an invalid sender QQ: %s",
    (userId) => {
      expect(isReplySenderAllowed(userId, "171419991")).toBe(false);
    }
  );

  it("keeps administrator identity checks exact", () => {
    expect(isAdminSender(171419991, "171419991")).toBe(true);
    expect(isAdminSender(998877665, "171419991")).toBe(false);
    expect(isAdminSender(171419991, "not-a-qq")).toBe(false);
  });
});
