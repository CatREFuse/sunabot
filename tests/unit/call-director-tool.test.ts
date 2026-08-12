// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runCallDirector } from "../../services/tools/callDirectorTool.js";

describe("call_director tool", () => {
  it("passes one normalized in-world change request to the Director port", async () => {
    const execute = vi.fn(async (input) => ({ ok: true, input }));

    await expect(runCallDirector({ request: "  下午改为和前辈一起复核资料  " }, { execute }))
      .resolves.toEqual({ ok: true, input: { request: "下午改为和前辈一起复核资料" } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects blank, oversized and additional arguments before execution", async () => {
    const execute = vi.fn();

    await expect(runCallDirector({ request: "" }, { execute })).resolves.toMatchObject({
      ok: false,
      code: "CALL_DIRECTOR_INVALID"
    });
    await expect(runCallDirector({ request: "x".repeat(4_001) }, { execute })).resolves.toMatchObject({
      ok: false,
      code: "CALL_DIRECTOR_INVALID"
    });
    await expect(runCallDirector({ request: "改期", target: "tomorrow" }, { execute })).resolves.toMatchObject({
      ok: false,
      code: "CALL_DIRECTOR_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
