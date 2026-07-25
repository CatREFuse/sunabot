// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  appendReplySoftErrors,
  isolateReplyModule
} from "../../src/runtime/replyModuleIsolation.js";

describe("reply module isolation", () => {
  it("uses a local fallback without exposing the module failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await isolateReplyModule(
      "agent_extensions",
      async () => { throw new Error("/private/workspace/secret"); },
      () => ({ available: false })
    );

    expect(result).toEqual({ available: false });
    expect(errorLog).toHaveBeenCalledWith(
      "[runtime] optional reply module unavailable",
      expect.objectContaining({ module: "agent_extensions" })
    );
    errorLog.mockRestore();
  });

  it("never turns cancellation into an optional-module fallback", async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error("superseded"), { name: "AbortError" });
    controller.abort(cancellation);

    await expect(isolateReplyModule(
      "memory",
      async () => { throw cancellation; },
      () => "fallback",
      { signal: controller.signal }
    )).rejects.toBe(cancellation);
  });

  it("merges deduplicated soft errors after the complete reply", () => {
    expect(appendReplySoftErrors(
      "正文\n（错误：附件暂不可用）",
      ["表达优化暂不可用", "附件暂不可用"]
    )).toBe("正文\n（错误：附件暂不可用；表达优化暂不可用）");
  });
});
