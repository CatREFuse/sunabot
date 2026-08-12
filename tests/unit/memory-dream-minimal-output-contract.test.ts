// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DreamModelOutputContractError,
  parseStrictMinimalDreamModelOutput
} from "../../services/memory/dream/public.js";

function validOutput() {
  return {
    workingMemoryCompression: "发布必须等自动回归全部通过后才能确认完成。",
    longTermMemoryAdditions: ["每次发布都必须等自动回归全部通过后才能确认完成。"],
    dreamDescription: "我梦见一排测试灯依次亮起，最后一盏亮起时，写着完成的门才缓缓打开。"
  };
}

function expectFailure(value: unknown) {
  expect(() => parseStrictMinimalDreamModelOutput(JSON.stringify(value)))
    .toThrowError(DreamModelOutputContractError);
}

describe("minimal Dream output contract", () => {
  it("accepts exactly three ordered fields and preserves their content", () => {
    const value = validOutput();
    expect(parseStrictMinimalDreamModelOutput(JSON.stringify(value))).toEqual(value);
  });

  it("accepts zero long-term additions without exposing the internal decision", () => {
    const value = validOutput();
    value.longTermMemoryAdditions = [];
    expect(parseStrictMinimalDreamModelOutput(JSON.stringify(value)))
      .toMatchObject({ longTermMemoryAdditions: [] });
  });

  it("accepts empty compression and additions when the working batch is empty", () => {
    const value = {
      workingMemoryCompression: "",
      longTermMemoryAdditions: [],
      dreamDescription: "我梦见一间安静的空房，窗外只有缓慢移动的云。"
    };
    expect(parseStrictMinimalDreamModelOutput(JSON.stringify(value)))
      .toEqual(value);
  });

  it("rejects a different top-level order and any fourth field", () => {
    const value = validOutput();
    expectFailure({
      dreamDescription: value.dreamDescription,
      workingMemoryCompression: value.workingMemoryCompression,
      longTermMemoryAdditions: value.longTermMemoryAdditions
    });
    expectFailure({ ...value, personaAdjustment: null });
  });

  it("rejects the removed item and source-id wrappers", () => {
    expectFailure({
      ...validOutput(),
      workingMemoryCompression: { items: [] }
    });
    expectFailure({
      ...validOutput(),
      longTermMemoryAdditions: { items: [] }
    });
    expectFailure({
      ...validOutput(),
      longTermMemoryAdditions: [{ fact: "不再接受对象项" }]
    });
  });

  it("rejects visible reasons, decisions, and reasoning fields", () => {
    expectFailure({ ...validOutput(), reason: "不应输出" });
    expectFailure({ ...validOutput(), decision: "不应输出" });
    expectFailure({ ...validOutput(), reasoning: "不应输出" });
  });

  it("rejects a working-memory replacement larger than the document item limit", () => {
    expectFailure({
      ...validOutput(),
      workingMemoryCompression: "记".repeat(4_001)
    });
  });
});
