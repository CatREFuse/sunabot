import { describe, expect, it } from "vitest";
import { formatDashboardMetric, formatExactNumber } from "./numberFormat";

describe("dashboard number formatting", () => {
  it("uses localized thousands and keeps dashboard values in K units", () => {
    expect(formatDashboardMetric(999)).toBe("999");
    expect(formatDashboardMetric(1_234)).toBe("1.2K");
    expect(formatDashboardMetric(1_234_567)).toBe("1,234.6K");
    expect(formatExactNumber(1_234_567)).toBe("1,234,567");
  });
});
