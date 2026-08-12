// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  addWorkMemoryTool,
  runAddWorkMemory
} from "../../services/tools/addWorkMemoryTool.js";

describe("add_workmemory tool", () => {
  it("guides the model toward natural first-person event memory without adding a host wording gate", () => {
    expect(addWorkMemoryTool.description).toContain("first-person natural-language account");
    expect(addWorkMemoryTool.description).toContain("time, place or conversation field, people, event, and feelings");
    expect(addWorkMemoryTool.description).toContain("without turning them into labeled fields");
    expect(addWorkMemoryTool.description).toContain("later consolidation can connect related memories");
    expect(addWorkMemoryTool.description).toContain("internal timeline");
    expect(addWorkMemoryTool.description).toContain("The host does not reject content");
  });

  it("requires portable Markdown links for remembered knowledge images", () => {
    expect(addWorkMemoryTool.description).toContain("![红色方块参考](red-square.png)");
    expect(addWorkMemoryTool.description).toContain("![红色方块参考](knowledge/references/red-square.png)");
    expect(addWorkMemoryTool.description).toContain("rather than leaving a bare path");
    expect(addWorkMemoryTool.parameters.properties.content.description)
      .toContain("real Markdown link whose target starts with knowledge/");
  });

  it("passes a record decision with only trimmed content to the host-bound runtime port", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runAddWorkMemory({
      action: "record",
      content: "  继续跟进 Markdown 记忆门禁  "
    }, { execute }))
      .resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({
      action: "record",
      content: "继续跟进 Markdown 记忆门禁"
    }, undefined);
  });

  it("passes a skip decision only when content is null", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runAddWorkMemory({ action: "skip", content: null }, { execute }))
      .resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ action: "skip" }, undefined);
  });

  it("uses Unicode characters for the 4000-character boundary", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const content = "😀".repeat(4_000);

    await expect(runAddWorkMemory({ action: "record", content }, { execute }))
      .resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ action: "record", content }, undefined);

    execute.mockClear();
    await expect(runAddWorkMemory({
      action: "record",
      content: "😀".repeat(4_001)
    }, { execute })).resolves.toMatchObject({
      ok: false,
      code: "ADD_WORKMEMORY_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    "老师（QQ 171419991）要求我下次继续跟进，但正文没有以角色第一人称开头。",
    "我记得这是一条尚未经过后续整理的临时记录。",
    "相关用户：QQ 999999999；稍后再核对称呼与事件结构。"
  ])("passes semantically unreviewed content through for later consolidation: %s", async (content) => {
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runAddWorkMemory({ action: "record", content }, { execute })).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ action: "record", content }, undefined);
  });

  it.each([
    [null],
    [{}],
    [{ content: "" }],
    [{ action: "record", content: null }],
    [{ action: "skip", content: "" }],
    [{ action: "skip" }],
    [{ action: "other", content: null }],
    [{ content: "有效", recordedAt: "1999-01-01T00:00:00+00:00" }],
    [{ content: "有效", conversationId: "other-agent:private:1" }],
    [{ action: "record", content: "x".repeat(4_001) }]
  ])("rejects forged metadata and invalid arguments %#", async (input) => {
    const execute = vi.fn();
    await expect(runAddWorkMemory(input, { execute })).resolves.toMatchObject({
      ok: false,
      code: "ADD_WORKMEMORY_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
