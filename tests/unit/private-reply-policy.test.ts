// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isPrivateReplyAllowed } from "../../services/messaging/privateReplyPolicy.js";

describe("private reply allowlist", () => {
  it("keeps existing behavior when no allowlist is configured", () => {
    expect(isPrivateReplyAllowed(123456789, undefined)).toBe(true);
    expect(isPrivateReplyAllowed(123456789, "   ")).toBe(true);
  });

  it("only permits explicitly listed QQ accounts", () => {
    expect(isPrivateReplyAllowed(171419991, "171419991, 223344556")).toBe(true);
    expect(isPrivateReplyAllowed(998877665, "171419991, 223344556")).toBe(false);
  });

  it("fails closed when the configured list contains an invalid account", () => {
    expect(isPrivateReplyAllowed(171419991, "171419991,not-a-qq")).toBe(false);
  });
});
