import { describe, expect, it } from "vitest";
import { isSpaRoute } from "../../apps/api/spaRouting.js";

describe("SPA routing", () => {
  it("serves registered pages for direct navigation and nested paths", () => {
    expect(isSpaRoute("/director")).toBe(true);
    expect(isSpaRoute("/director/history")).toBe(true);
    expect(isSpaRoute("/design-demo")).toBe(true);
    expect(isSpaRoute("/design-demo/settings")).toBe(true);
  });

  it("keeps API and unknown paths outside the SPA fallback", () => {
    expect(isSpaRoute("/api/director/schedules")).toBe(false);
    expect(isSpaRoute("/unknown")).toBe(false);
  });
});
