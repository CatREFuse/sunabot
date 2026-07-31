// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_RAW_OUTPUT_MAX_CODE_POINTS,
  DreamModelOutputContractError,
  parseStrictDreamModelOutput
} from "../../services/memory/dream/public.js";

const expected = {
  longTermMemoryIds: ["long_term_a"],
  workingMemoryIds: ["working_a", "working_b"],
  personaEvidenceIds: ["long_term_a", "working_a"],
  fieldKnowledgeEvidenceIds: ["long_term_a", "working_a"],
  fieldKnowledgeWritable: true
};

function validOutput() {
  return {
    schemaVersion: 1,
    dream: {
      text: "我梦见一座安静的车站，发布清单变成沿轨道亮起的灯，我把仍会影响未来的门槛放进最容易找到的抽屉。",
      factuality: "imagined"
    },
    longTermReviews: [{
      sourceIds: ["long_term_a"],
      action: "retain",
      canonical: null,
      importance: 0.8,
      futureRelevance: 0.9,
      emotionalSalience: 0.2,
      confidence: 1,
      reason: "仍会影响后续发布"
    }],
    workingReviews: [
      {
        sourceIds: ["working_a"],
        action: "promote",
        canonical: { fact: "每次发布都必须等回归测试全部通过后才能确认上线。" },
        confidence: 0.98,
        reason: "这是持续有效的发布门槛"
      },
      {
        sourceIds: ["working_b"],
        action: "retain",
        canonical: null,
        confidence: 0.9,
        reason: "仍在近期工作中使用"
      }
    ],
    personaAdjustment: null,
    fieldKnowledge: null
  };
}

function parse(value: unknown) {
  return parseStrictDreamModelOutput(JSON.stringify(value), expected);
}

function expectContractFailure(value: unknown) {
  expect(() => parse(value)).toThrowError(DreamModelOutputContractError);
  try {
    parse(value);
  } catch (error) {
    expect(error).toMatchObject({
      code: "DREAM_OUTPUT_CONTRACT_INVALID",
      retryable: true
    });
  }
}

describe("strict Dream model output contract", () => {
  it("accepts a complete promote decision without changing its canonical fact", () => {
    const text = JSON.stringify(validOutput());
    const output = parseStrictDreamModelOutput(text, expected);

    expect(output.workingReviews[0]).toEqual({
      sourceIds: ["working_a"],
      action: "promote",
      canonical: { fact: "每次发布都必须等回归测试全部通过后才能确认上线。" },
      confidence: 0.98,
      reason: "这是持续有效的发布门槛"
    });
    expect(output.rawOutput).toBe(text);
  });

  it("rejects non-JSON output and snake_case aliases", () => {
    expect(() => parseStrictDreamModelOutput("一段没有 JSON 包装的梦。", expected))
      .toThrowError(DreamModelOutputContractError);

    const aliased = validOutput() as Record<string, unknown>;
    aliased.working_reviews = aliased.workingReviews;
    delete aliased.workingReviews;
    expectContractFailure(aliased);
  });

  it("rejects fenced output even when the enclosed JSON is complete", () => {
    expect(() => parseStrictDreamModelOutput(
      `\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``,
      expected
    )).toThrowError(DreamModelOutputContractError);
  });

  it.each([
    ["wrong schema version", (value: ReturnType<typeof validOutput>) => {
      value.schemaVersion = 2;
    }],
    ["unknown top-level field", (value: ReturnType<typeof validOutput>) => {
      (value as unknown as Record<string, unknown>).extra = true;
    }],
    ["missing top-level field", (value: ReturnType<typeof validOutput>) => {
      delete (value as unknown as Record<string, unknown>).personaAdjustment;
    }],
    ["object-key review collection", (value: ReturnType<typeof validOutput>) => {
      value.workingReviews = {
        working_a: value.workingReviews[0]
      } as never;
    }],
    ["unknown dream field", (value: ReturnType<typeof validOutput>) => {
      (value.dream as unknown as Record<string, unknown>).extra = true;
    }],
    ["missing dream field", (value: ReturnType<typeof validOutput>) => {
      delete (value.dream as { text?: string }).text;
    }],
    ["invalid dream factuality", (value: ReturnType<typeof validOutput>) => {
      value.dream.factuality = "factual" as never;
    }],
    ["unknown review field", (value: ReturnType<typeof validOutput>) => {
      (value.workingReviews[0] as unknown as Record<string, unknown>).extra = true;
    }],
    ["missing review field", (value: ReturnType<typeof validOutput>) => {
      delete (value.workingReviews[0] as unknown as Record<string, unknown>).reason;
    }],
    ["missing long-term score field", (value: ReturnType<typeof validOutput>) => {
      delete (value.longTermReviews[0] as unknown as Record<string, unknown>).importance;
    }],
    ["unsupported review action", (value: ReturnType<typeof validOutput>) => {
      value.workingReviews[0]!.action = "archive";
    }],
    ["canonical supplied for retain", (value: ReturnType<typeof validOutput>) => {
      value.workingReviews[1]!.canonical = { fact: "不应存在" };
    }],
    ["single-source merge", (value: ReturnType<typeof validOutput>) => {
      value.workingReviews[0]!.action = "merge";
    }],
    ["null canonical for promote", (value: ReturnType<typeof validOutput>) => {
      value.workingReviews[0]!.canonical = null;
    }],
    ["unknown canonical field", (value: ReturnType<typeof validOutput>) => {
      (value.workingReviews[0]!.canonical as unknown as Record<string, unknown>).extra = true;
    }],
    ["missing canonical fact", (value: ReturnType<typeof validOutput>) => {
      delete (value.workingReviews[0]!.canonical as unknown as Record<string, unknown>).fact;
    }],
    ["score above one", (value: ReturnType<typeof validOutput>) => {
      value.longTermReviews[0]!.importance = 1.1;
    }],
    ["non-numeric score", (value: ReturnType<typeof validOutput>) => {
      value.longTermReviews[0]!.importance = "high" as never;
    }],
    ["unknown persona field", (value: ReturnType<typeof validOutput>) => {
      value.personaAdjustment = {
        kind: "habit",
        targetFile: "PREFERENCE.md",
        topicKey: "release.habit",
        statement: "会持续遵守经过确认的发布门槛。",
        evidenceMemoryIds: ["working_a", "long_term_a"],
        extra: true
      } as never;
    }],
    ["missing persona field", (value: ReturnType<typeof validOutput>) => {
      value.personaAdjustment = {
        kind: "habit",
        targetFile: "PREFERENCE.md",
        topicKey: "release.habit",
        evidenceMemoryIds: ["working_a", "long_term_a"]
      } as never;
    }],
    ["unknown field-knowledge field", (value: ReturnType<typeof validOutput>) => {
      value.fieldKnowledge = {
        content: "# 场域知识\n## 使用边界\n## 场域约定",
        evidenceMemoryIds: [],
        extra: true
      } as never;
    }],
    ["missing field-knowledge field", (value: ReturnType<typeof validOutput>) => {
      value.fieldKnowledge = {
        content: "# 场域知识\n## 使用边界\n## 场域约定"
      } as never;
    }]
  ])("rejects %s", (_name, mutate) => {
    const value = structuredClone(validOutput());
    mutate(value);
    expectContractFailure(value);
  });

  it("rejects missing required fields and incomplete source coverage", () => {
    const missingField = validOutput();
    delete (missingField.workingReviews[0] as { reason?: string }).reason;
    expectContractFailure(missingField);

    const missingSource = validOutput();
    missingSource.workingReviews = [missingSource.workingReviews[0]!];
    expectContractFailure(missingSource);
  });

  it("rejects unknown, duplicate, and cross-partition source ids", () => {
    const unknown = validOutput();
    unknown.workingReviews[1]!.sourceIds = ["working_unknown"];
    expectContractFailure(unknown);

    const duplicate = validOutput();
    duplicate.workingReviews[1]!.sourceIds = ["working_a"];
    expectContractFailure(duplicate);

    const crossed = validOutput();
    crossed.workingReviews[1]!.sourceIds = ["long_term_a"];
    expectContractFailure(crossed);
  });

  it("rejects malformed optional persona and field-knowledge objects instead of normalizing them", () => {
    const persona = validOutput();
    persona.personaAdjustment = {
      kind: "habit",
      targetFile: "PREFERENCE.md",
      topicKey: "release.habit",
      statement: "会持续遵守经过确认的发布门槛。",
      evidenceMemoryIds: ["working_unknown", "long_term_a"]
    } as never;
    expectContractFailure(persona);

    const fieldKnowledge = validOutput();
    fieldKnowledge.fieldKnowledge = {
      content: "# 错误标题\n## 使用边界\n## 场域约定",
      evidenceMemoryIds: []
    } as never;
    expectContractFailure(fieldKnowledge);
  });

  it.each([
    ["dream text", (value: ReturnType<typeof validOutput>) => {
      value.dream.text = `我梦见人物-${"a".repeat(24)}站在车站。`;
    }],
    ["legacy dream text", (value: ReturnType<typeof validOutput>) => {
      value.dream.text = `我梦见人物-${"a".repeat(10)}站在车站。`;
    }],
    ["canonical fact", (value: ReturnType<typeof validOutput>) => {
      value.workingReviews[0]!.canonical = { fact: `person:${"b".repeat(24)}负责发布。` };
    }],
    ["persona statement", (value: ReturnType<typeof validOutput>) => {
      value.personaAdjustment = {
        kind: "habit",
        targetFile: "PREFERENCE.md",
        topicKey: "release.habit",
        statement: `与人物-${"c".repeat(24)}协作时会重视证据。`,
        evidenceMemoryIds: ["working_a", "long_term_a"]
      };
    }],
    ["field knowledge", (value: ReturnType<typeof validOutput>) => {
      value.fieldKnowledge = {
        content: `# 场域知识\n## 使用边界\n- 只在协作群生效。\n## 场域约定\n- profile:${"d".repeat(24)}负责复核。`,
        evidenceMemoryIds: []
      };
    }],
    ["case-varied alias", (value: ReturnType<typeof validOutput>) => {
      value.dream.text = `我梦见 Person:${"A".repeat(24)} 站在车站。`;
    }],
    ["prefixed alias fragment", (value: ReturnType<typeof validOutput>) => {
      value.dream.text = `我梦见 xperson:${"e".repeat(24)} 站在车站。`;
    }],
    ["suffixed alias fragment", (value: ReturnType<typeof validOutput>) => {
      value.dream.text = `我梦见 person:${"f".repeat(24)}_suffix 站在车站。`;
    }],
    ["case-varied surrounded alias fragment", (value: ReturnType<typeof validOutput>) => {
      value.dream.text = `我梦见 XPROFILE:${"C".repeat(24)}Z 站在车站。`;
    }]
  ])("rejects legacy host-generated identity aliases in %s", (_name, mutate) => {
    const value = structuredClone(validOutput());
    mutate(value);
    expectContractFailure(value);
  });

  it("accepts ordinary Chinese identity prose and short human-readable labels", () => {
    const value = validOutput();
    value.dream.text = "我梦见人物关系图与 person:review 标签被放进同一只抽屉。";

    expect(parse(value).dream.text).toBe(value.dream.text);
  });

  it("requires null field knowledge when the persisted input is not writable", () => {
    const value = validOutput();
    value.fieldKnowledge = {
      content: "# 场域知识\n## 使用边界\n## 场域约定\n- 只在指定范围内使用。",
      evidenceMemoryIds: ["long_term_a"]
    } as never;

    expect(() => parseStrictDreamModelOutput(JSON.stringify(value), {
      ...expected,
      fieldKnowledgeWritable: false
    })).toThrowError(DreamModelOutputContractError);

    const {
      fieldKnowledgeWritable: _fieldKnowledgeWritable,
      ...legacyExpected
    } = expected;
    expect(() => parseStrictDreamModelOutput(JSON.stringify(value), legacyExpected))
      .toThrowError(DreamModelOutputContractError);

    expect(parseStrictDreamModelOutput(JSON.stringify(value), expected).fieldKnowledge)
      .toEqual(value.fieldKnowledge);
  });

  it("allows a 16k field document inside the 64k total response budget", () => {
    expect(DREAM_RAW_OUTPUT_MAX_CODE_POINTS).toBe(64_000);
    const value = validOutput();
    const fieldContent = `# 场域知识\n## 使用边界\n## 场域约定\n${"内".repeat(15_900)}`;
    value.fieldKnowledge = {
      content: fieldContent,
      evidenceMemoryIds: []
    } as never;
    const text = JSON.stringify(value);

    expect(Array.from(text).length).toBeGreaterThan(16_000);
    expect(parseStrictDreamModelOutput(text, expected).fieldKnowledge?.content)
      .toBe(fieldContent);
  });
});
