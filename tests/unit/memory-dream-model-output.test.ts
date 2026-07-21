// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  normalizeDreamModelOutput,
  parseDreamModelOutput
} from "../../services/memory/dream/public.js";

const expected = {
  longTermMemoryIds: ["long_term_a", "long_term_b", "long_term_c"],
  workingMemoryIds: ["working_a", "working_b"],
  personaEvidenceIds: ["long_term_a", "long_term_b", "working_a"]
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
      statement: "交流时会更主动确认对方真正关心的结果。",
      evidenceMemoryIds: ["long_term_a", "long_term_b", "working_a"]
    }
  };
}

describe("Dream model output", () => {
  it("strictly parses schema v1, counts Unicode code points, and preserves imagined status", () => {
    const output = parseDreamModelOutput(JSON.stringify(validOutput()), expected);
    expect(Array.from(output.dream.text)).toHaveLength(160);
    expect(output.dream.factuality).toBe("imagined");
    expect(output.longTermReviews[0]).toMatchObject({ action: "merge", sourceIds: ["long_term_a", "long_term_b"] });
  });

  it("rejects unsupported schemas, fields, factual dreams, and out-of-range descriptions", () => {
    expect(() => normalizeDreamModelOutput({ ...validOutput(), schemaVersion: 2 }, expected))
      .toThrow("schemaVersion must be 1");
    expect(() => normalizeDreamModelOutput({ ...validOutput(), extra: true }, expected))
      .toThrow("unsupported field extra");
    expect(() => normalizeDreamModelOutput({
      ...validOutput(),
      dream: { text: "梦".repeat(160), factuality: "factual" }
    }, expected)).toThrow("factuality must be imagined");
    expect(() => normalizeDreamModelOutput({
      ...validOutput(),
      dream: { text: "梦".repeat(159), factuality: "imagined" }
    }, expected)).toThrow("160 to 260");
    expect(() => normalizeDreamModelOutput({
      ...validOutput(),
      dream: { text: "梦".repeat(261), factuality: "imagined" }
    }, expected)).toThrow("160 to 260");
  });

  it("requires exact input partitions and rejects unknown, missing, or duplicate ids", () => {
    const unknown = validOutput();
    unknown.longTermReviews[1]!.sourceIds = ["long_term_fabricated"];
    expect(() => normalizeDreamModelOutput(unknown, expected)).toThrow("unknown memory id long_term_fabricated");

    const missing = validOutput();
    missing.workingReviews.pop();
    expect(() => normalizeDreamModelOutput(missing, expected)).toThrow("missing memory id working_b");

    const duplicate = validOutput();
    duplicate.workingReviews[1]!.sourceIds = ["working_a"];
    expect(() => normalizeDreamModelOutput(duplicate, expected)).toThrow("duplicate memory id working_a");
  });

  it("requires at least two sources and canonical text for merges", () => {
    const singleMerge = validOutput();
    singleMerge.longTermReviews = [
      { ...singleMerge.longTermReviews[0]!, sourceIds: ["long_term_a"] },
      { ...singleMerge.longTermReviews[1]!, sourceIds: ["long_term_b"] },
      { ...singleMerge.longTermReviews[1]!, sourceIds: ["long_term_c"] }
    ];
    expect(() => normalizeDreamModelOutput(singleMerge, expected)).toThrow("merge requires at least 2 sourceIds");

    const missingCanonical = validOutput();
    missingCanonical.longTermReviews[0]!.canonical = null;
    expect(() => normalizeDreamModelOutput(missingCanonical, expected)).toThrow("merge requires canonical memory");
  });

  it("accepts an explicit single-memory rewrite and rejects a rewrite without canonical text", () => {
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
    expect(() => normalizeDreamModelOutput(missingCanonical, expected))
      .toThrow("rewrite requires canonical memory");
  });

  it("allows only adaptive persona targets backed by known factual memory ids", () => {
    const relation = validOutput();
    relation.personaAdjustment = {
      kind: "relationship_tendency",
      targetFile: "RELATION.md",
      statement: "相处时会更留意持续兑现的承诺。",
      evidenceMemoryIds: ["long_term_a", "long_term_b", "working_a"]
    };
    expect(normalizeDreamModelOutput(relation, expected).personaAdjustment?.targetFile).toBe("RELATION.md");

    const coreFile = validOutput();
    coreFile.personaAdjustment!.targetFile = "SOUL.md" as "PREFERENCE.md";
    expect(() => normalizeDreamModelOutput(coreFile, expected)).toThrow("targetFile is invalid");

    const dreamEvidence = validOutput();
    dreamEvidence.personaAdjustment!.evidenceMemoryIds[2] = "working_b";
    expect(() => normalizeDreamModelOutput(dreamEvidence, expected)).toThrow("unknown or imagined evidence id working_b");
  });
});
