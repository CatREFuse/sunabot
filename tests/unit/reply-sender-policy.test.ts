// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";

describe("reply sender policy", () => {
  it("only permits the configured administrator QQ", () => {
    expect(isReplySenderAllowed(171419991, "171419991")).toBe(true);
    expect(isReplySenderAllowed(998877665, "171419991")).toBe(false);
  });

  it.each([undefined, "", "   ", "not-a-qq", "171419991,223344556", "1234"])(
    "fails closed for a missing or invalid administrator QQ: %s",
    (adminQq) => {
      expect(isReplySenderAllowed(171419991, adminQq)).toBe(false);
    }
  );

  it.each(["", "not-a-qq", "1234", "171419991,223344556"])(
    "fails closed for an invalid sender QQ: %s",
    (userId) => {
      expect(isReplySenderAllowed(userId, "171419991")).toBe(false);
    }
  );
});
