// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  normalizeDreamModelOutput,
  parseDreamModelOutput
} from "../../services/memory/dream/public.js";

const expected = {
  longTermMemoryIds: ["long_term_a", "long_term_b", "long_term_c"],
  workingMemoryIds: ["working_a", "working_b"],
  personaEvidenceIds: ["long_term_a", "long_term_b", "working_a"],
  fieldKnowledgeEvidenceIds: ["long_term_c", "working_a"]
};

function validOutput() {
  return {
    schemaVersion: 1,
    dream: {
      text: `${"梦".repeat(159)}🌙`,
      factuality: "imagined"
    },
    longTermReviews: [
      {
        sourceIds: ["long_term_a", "long_term_b"],
        action: "merge",
        canonical: { fact: "同一件事的原因、变化和最新结果被整理到一起。" },
        importance: 0.7,
        futureRelevance: 0.5,
        emotionalSalience: 0.6,
        confidence: 0.9,
        reason: "两条记录属于同一事件。"
      },
      {
        sourceIds: ["long_term_c"],
        action: "retain",
        canonical: null,
        importance: 0.8,
        futureRelevance: 0.7,
        emotionalSalience: 0.3,
        confidence: 0.9,
        reason: "仍会影响后续互动。"
      }
    ],
    workingReviews: [
      {
        sourceIds: ["working_a"],
        action: "promote",
        canonical: { fact: "这件事值得长期保留。" },
        confidence: 0.95,
        reason: "仍会影响未来"
      },
      {
        sourceIds: ["working_b"],
        action: "discard",
        canonical: null,
        confidence: 0.95,
        reason: "仅为重复流水账"
      }
    ],
    personaAdjustment: {
      kind: "communication_preference",
      targetFile: "PREFERENCE.md",
      topicKey: "communication.result_focus",
      statement: "交流时会更主动确认对方真正关心的结果。",
      evidenceMemoryIds: ["long_term_a", "long_term_b", "working_a"]
    },
    fieldKnowledge: {
      content: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n### context:release\n\n- 发布前需要双人复核。",
      evidenceMemoryIds: ["long_term_c", "unknown", "working_a"]
    }
  };
}

describe("Dream model output", () => {
  it("parses the preferred JSON shape and preserves the raw generated output", () => {
    const output = parseDreamModelOutput(JSON.stringify(validOutput()), expected);
    expect(Array.from(output.dream.text)).toHaveLength(160);
    expect(output.dream.factuality).toBe("imagined");
    expect(output.rawOutput).toContain("\"workingReviews\"");
    expect(output.longTermReviews[0]).toMatchObject({ action: "merge", sourceIds: ["long_term_a", "long_term_b"] });
    expect(output.fieldKnowledge).toEqual({
      content: expect.stringContaining("## 场域约定"),
      evidenceMemoryIds: ["long_term_c", "working_a"]
    });
  });

  it("accepts non-JSON generated text and safely retains every memory", () => {
    const output = parseDreamModelOutput("梦里只有一条没有 JSON 包装的走廊。", expected);
    expect(output).toMatchObject({
      dream: { text: "梦里只有一条没有 JSON 包装的走廊。", factuality: "imagined" },
      longTermReviews: [
        { sourceIds: ["long_term_a"], action: "retain", confidence: 0 },
        { sourceIds: ["long_term_b"], action: "retain", confidence: 0 },
        { sourceIds: ["long_term_c"], action: "retain", confidence: 0 }
      ],
      workingReviews: [
        { sourceIds: ["working_a"], action: "retain", confidence: 0 },
        { sourceIds: ["working_b"], action: "retain", confidence: 0 }
      ]
    });
    expect(output.rawOutput).toBe("梦里只有一条没有 JSON 包装的走廊。");
  });

  it("treats generated schema, extra fields, factuality, and length as soft guidance", () => {
    const output = normalizeDreamModelOutput({
      ...validOutput(),
      schemaVersion: 99,
      extra: true,
      dream: { text: "短梦", factuality: "factual", style: "free" }
    }, expected);
    expect(output.dream).toEqual({ text: "短梦", factuality: "imagined" });

    const long = normalizeDreamModelOutput({
      ...validOutput(),
      dream: { text: "梦".repeat(5_000), factuality: "imagined" }
    }, expected);
    expect(Array.from(long.dream.text)).toHaveLength(4_096);
  });

  it("ignores unknown and duplicate generated ids and fills every missing source with retain", () => {
    const malformed = validOutput();
    malformed.longTermReviews[1]!.sourceIds = ["long_term_fabricated"];
    malformed.workingReviews[1]!.sourceIds = ["working_a"];
    const output = normalizeDreamModelOutput(malformed, expected);
    expect(output.longTermReviews.flatMap((review) => review.sourceIds)).toEqual([
      "long_term_a",
      "long_term_b",
      "long_term_c"
    ]);
    expect(output.longTermReviews.at(-1)).toMatchObject({
      sourceIds: ["long_term_c"],
      action: "retain",
      confidence: 0
    });
    expect(output.workingReviews).toEqual([
      expect.objectContaining({ sourceIds: ["working_a"], action: "promote" }),
      expect.objectContaining({ sourceIds: ["working_b"], action: "retain", confidence: 0 })
    ]);
  });

  it("downgrades unusable generated actions to safe retain operations", () => {
    const singleMerge = validOutput();
    singleMerge.longTermReviews = [
      { ...singleMerge.longTermReviews[0]!, sourceIds: ["long_term_a"] },
      { ...singleMerge.longTermReviews[1]!, sourceIds: ["long_term_b"] },
      { ...singleMerge.longTermReviews[1]!, sourceIds: ["long_term_c"] }
    ];
    singleMerge.workingReviews[0]!.confidence = undefined as unknown as number;
    singleMerge.workingReviews[0]!.reason = undefined as unknown as string;
    const output = normalizeDreamModelOutput(singleMerge, expected);
    expect(output.longTermReviews[0]).toMatchObject({
      sourceIds: ["long_term_a"],
      action: "retain",
      confidence: 0
    });
    expect(output.workingReviews[0]).toMatchObject({
      sourceIds: ["working_a"],
      action: "promote",
      confidence: 0,
      reason: ""
    });
  });

  it("accepts a usable rewrite and retains the source when generated canonical text is missing", () => {
    const rewrite = validOutput();
    rewrite.longTermReviews[1] = {
      ...rewrite.longTermReviews[1]!,
      action: "rewrite",
      canonical: { fact: "整理后的长期事实。" }
    };
    rewrite.workingReviews[1] = {
      ...rewrite.workingReviews[1]!,
      action: "rewrite",
      canonical: { fact: "整理后的工作事实。" }
    };
    expect(normalizeDreamModelOutput(rewrite, expected)).toMatchObject({
      longTermReviews: expect.arrayContaining([expect.objectContaining({ action: "rewrite" })]),
      workingReviews: expect.arrayContaining([expect.objectContaining({ action: "rewrite" })])
    });

    const missingCanonical = validOutput();
    missingCanonical.workingReviews[1] = {
      ...missingCanonical.workingReviews[1]!,
      action: "rewrite",
      canonical: null
    };
    expect(normalizeDreamModelOutput(missingCanonical, expected).workingReviews[1])
      .toMatchObject({ sourceIds: ["working_b"], action: "retain" });
  });

  it("keeps a valid persona proposal and drops malformed generated proposals without failing Dream", () => {
    const relation = validOutput();
    relation.personaAdjustment = {
      kind: "relationship_tendency",
      targetFile: "RELATION.md",
      topicKey: "relationship.commitment",
      statement: "相处时会更留意持续兑现的承诺。",
      evidenceMemoryIds: ["long_term_a", "long_term_b", "working_a"]
    };
    expect(normalizeDreamModelOutput(relation, expected).personaAdjustment?.targetFile).toBe("RELATION.md");

    const missingTopic = validOutput();
    delete (missingTopic.personaAdjustment as { topicKey?: string }).topicKey;
    expect(normalizeDreamModelOutput(missingTopic, expected).personaAdjustment).toBeNull();

    const invalidTopic = validOutput();
    invalidTopic.personaAdjustment!.topicKey = "无效主题";
    expect(normalizeDreamModelOutput(invalidTopic, expected).personaAdjustment).toBeNull();

    const observation = validOutput();
    observation.personaAdjustment!.evidenceMemoryIds = ["long_term_a", "working_a"];
    expect(normalizeDreamModelOutput(observation, expected).personaAdjustment?.evidenceMemoryIds)
      .toEqual(["long_term_a", "working_a"]);

    const coreFile = validOutput();
    coreFile.personaAdjustment!.targetFile = "SOUL.md" as "PREFERENCE.md";
    expect(normalizeDreamModelOutput(coreFile, expected).personaAdjustment).toBeNull();

    const dreamEvidence = validOutput();
    dreamEvidence.personaAdjustment!.evidenceMemoryIds[2] = "working_b";
    expect(normalizeDreamModelOutput(dreamEvidence, expected).personaAdjustment).toBeNull();

    const overlongStatement = validOutput();
    overlongStatement.personaAdjustment!.statement = "倾".repeat(81);
    expect(normalizeDreamModelOutput(overlongStatement, expected).personaAdjustment).toBeNull();
  });

  it("keeps only scoped field-knowledge documents backed by allowed factual memories", () => {
    const invalidDocument = validOutput();
    invalidDocument.fieldKnowledge!.content = "# 场域知识\n\n今天下雨，午餐吃了披萨。";
    expect(normalizeDreamModelOutput(invalidDocument, expected).fieldKnowledge).toBeNull();

    const extraHeading = validOutput();
    extraHeading.fieldKnowledge!.content = [
      "# 场域知识",
      "## 使用边界",
      "仅限项目群。",
      "## 公共百科",
      "今天下雨。",
      "## 场域约定",
      "在项目群称小林为林老师。"
    ].join("\n\n");
    expect(normalizeDreamModelOutput(extraHeading, expected).fieldKnowledge).toBeNull();

    const misplacedHeading = validOutput();
    misplacedHeading.fieldKnowledge!.content = [
      "# 场域知识",
      "## 场域约定",
      "在项目群称小林为林老师。",
      "## 使用边界",
      "仅限项目群。"
    ].join("\n\n");
    expect(normalizeDreamModelOutput(misplacedHeading, expected).fieldKnowledge).toBeNull();

    const unknownEvidence = validOutput();
    unknownEvidence.fieldKnowledge!.evidenceMemoryIds = ["fabricated"];
    expect(normalizeDreamModelOutput(unknownEvidence, expected).fieldKnowledge).toBeNull();

    const cleanupOnly = validOutput();
    cleanupOnly.fieldKnowledge!.evidenceMemoryIds = [];
    expect(normalizeDreamModelOutput(cleanupOnly, expected).fieldKnowledge).toMatchObject({
      evidenceMemoryIds: []
    });
  });

  it("still rejects invalid host expectations because they are a code boundary", () => {
    expect(() => normalizeDreamModelOutput(validOutput(), {
      ...expected,
      workingMemoryIds: ["working_a", "working_a"]
    })).toThrow("workingMemoryIds must not contain duplicates");
  });
});
