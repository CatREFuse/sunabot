// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runAddWorkMemory } from "../../services/tools/addWorkMemoryTool.js";

describe("add_workmemory tool", () => {
  it("passes only trimmed content to the host-bound runtime port", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runAddWorkMemory({ content: "  继续跟进 Markdown 记忆门禁  " }, { execute }))
      .resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ content: "继续跟进 Markdown 记忆门禁" }, undefined);
  });

  it.each([
    "老师（QQ 171419991）要求我下次继续跟进，但正文没有以角色第一人称开头。",
    "我记得这是一条尚未经过后续整理的临时记录。",
    "相关用户：QQ 999999999；稍后再核对称呼与事件结构。"
  ])("passes semantically unreviewed content through for later consolidation: %s", async (content) => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runAddWorkMemory({ content }, { execute })).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ content }, undefined);
  });

  it.each([
    [null],
    [{}],
    [{ content: "" }],
    [{ content: "有效", recordedAt: "1999-01-01T00:00:00+00:00" }],
    [{ content: "有效", conversationId: "other-agent:private:1" }],
    [{ content: "x".repeat(4_001) }]
  ])("rejects forged metadata and invalid arguments %#", async (input) => {
    const execute = vi.fn();
    await expect(runAddWorkMemory(input, { execute })).resolves.toMatchObject({
      ok: false,
      code: "ADD_WORKMEMORY_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
