import { describe, expect, it } from "vitest";
import { formatDashboardMetric, formatExactNumber, formatPercent } from "./numberFormat";

describe("dashboard number formatting", () => {
  it("uses localized thousands and keeps dashboard values in K units", () => {
    expect(formatDashboardMetric(999)).toBe("999");
    expect(formatDashboardMetric(1_234)).toBe("1.2K");
    expect(formatDashboardMetric(1_234_567)).toBe("1,234.6K");
    expect(formatExactNumber(1_234_567)).toBe("1,234,567");
  });

  it("formats normalized cache rates without inventing a value for missing input", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.3333)).toBe("33.3%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe("--");
    expect(formatPercent(Number.NaN)).toBe("--");
  });
});
