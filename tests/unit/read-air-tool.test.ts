// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runReadAir } from "../../services/tools/readAirTool.js";

describe("read_air tool", () => {
  it("passes a trimmed character insight to the runtime port", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runReadAir({ insight: "  这个群里的 220V 是惩罚性玩笑  " }, { execute }))
      .resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ insight: "这个群里的 220V 是惩罚性玩笑" }, undefined);
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
