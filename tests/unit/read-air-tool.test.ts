// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readAirTool, runReadAir } from "../../services/tools/readAirTool.js";

describe("read_air tool", () => {
  it("passes a trimmed character insight to the runtime port", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runReadAir({ insight: "  只在项目群里称小林为林老师  " }, { execute }))
      .resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ insight: "只在项目群里称小林为林老师" }, undefined);
  });

  it("limits updates to durable scoped conventions", () => {
    expect(readAirTool.description).toContain("scoped");
    expect(readAirTool.description).toContain("nickname");
    expect(readAirTool.description).toContain("rule");
    expect(readAirTool.description).toContain("exception");
    expect(readAirTool.description).toContain("precondition");
    expect(readAirTool.description).toContain("weather");
    expect(readAirTool.description).toContain("meals");
    expect(readAirTool.description).toContain("public knowledge");
    expect(readAirTool.description).not.toContain("relationship changes");
    expect(readAirTool.description).not.toContain("shared topics");
  });

  it.each([
    [null],
    [{}],
    [{ insight: "" }],
    [{ insight: "有效", extra: true }],
    [{ insight: "x".repeat(4_001) }]
  ])("rejects invalid arguments %#", async (input) => {
    const execute = vi.fn();
    await expect(runReadAir(input, { execute })).resolves.toMatchObject({
      ok: false,
      code: "READ_AIR_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
