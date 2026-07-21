// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_CANONICAL_MIN_SOURCE_BIGRAM_COVERAGE,
  evaluateDreamCanonicalFact
} from "../../services/memory/dream/public.js";

describe("Dream canonical memory validation", () => {
  it("accepts deterministic deletion and reordering supported by source facts", () => {
    const rewrite = evaluateDreamCanonicalFact(
      "我经历发布延期，最后确认周五继续验收。",
      [{ fact: "我经历发布延期，讨论了许多重复过程，最后确认周五继续验收。" }]
    );
    const merge = evaluateDreamCanonicalFact(
      "我在雨天抵达旧车站；我从旧车站乘车离开。",
      [
        { fact: "我在雨天抵达旧车站。" },
        { fact: "我从旧车站乘车离开。" }
      ]
    );

    expect(rewrite).toMatchObject({ eligible: true, reasons: [] });
    expect(rewrite.sourceBigramCoverage).toBeGreaterThanOrEqual(DREAM_CANONICAL_MIN_SOURCE_BIGRAM_COVERAGE);
    expect(merge).toMatchObject({ eligible: true, reasons: [] });
  });

  it("rejects recall prompts and text without the role first person", () => {
    expect(evaluateDreamCanonicalFact("我记得今天继续整理发布清单。", [
      { fact: "我今天继续整理发布清单。" }
    ])).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["recall_prompt"]) });
    expect(evaluateDreamCanonicalFact("今天继续整理发布清单。", [
      { fact: "我今天继续整理发布清单。" }
    ])).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["missing_role_first_person"]) });
  });

  it("rejects user-reported first person as the role perspective", () => {
    expect(evaluateDreamCanonicalFact(
      "猫老师（QQ 123456789）说：我会继续验收。",
      [{
        fact: "猫老师（QQ 123456789）说：我会继续验收。",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      }]
    )).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["missing_role_first_person"])
    });

    expect(evaluateDreamCanonicalFact(
      "我听猫老师（QQ号：123456789）说：“我会继续验收。”",
      [{
        fact: "我听猫老师（QQ号：123456789）说：“我会继续验收。”",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      }]
    )).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["missing_role_first_person"])
    });

    expect(evaluateDreamCanonicalFact(
      "我听猫老师（QQ 123456789）说：我会继续验收。",
      [{
        fact: "我听猫老师（QQ 123456789）说：我会继续验收。",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      }]
    )).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["missing_role_first_person"])
    });
  });

  it("rejects unsupported QQ identities, names, numbers, and low-coverage additions", () => {
    const result = evaluateDreamCanonicalFact(
      "我与陌生人（987654321）在上海继续验收，并支付500元。",
      [{
        fact: "我与猫老师（123456789）继续验收。",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      }]
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "unsupported_identity",
      "unsupported_high_risk_claim",
      "insufficient_source_coverage"
    ]));
  });

  it("rejects a high-risk action or polarity change absent from the source", () => {
    const invented = evaluateDreamCanonicalFact(
      "我继续验收，并决定转账。",
      [{ fact: "我继续验收。" }]
    );
    const polarityFlip = evaluateDreamCanonicalFact(
      "我向对方转账。",
      [{ fact: "我没有向对方转账。" }]
    );

    expect(invented).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["unsupported_high_risk_claim"])
    });
    expect(polarityFlip).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["unsupported_high_risk_claim"])
    });
  });

  it("allows only identities already grounded by the source record", () => {
    const result = evaluateDreamCanonicalFact(
      "我与猫老师（123456789）继续验收。",
      [{
        fact: "我与猫老师继续验收。",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      }]
    );

    expect(result.eligible).toBe(true);
  });

  it("keeps every grounded address-name and QQ pairing during rewrite", () => {
    const source = {
      fact: "我与猫老师（QQ号：123456789）继续验收发布清单。",
      userIds: ["123456789"],
      addressNames: ["猫老师"]
    };

    expect(evaluateDreamCanonicalFact(
      "我继续验收发布清单。",
      [source]
    )).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["unsupported_identity"])
    });
    expect(evaluateDreamCanonicalFact(
      "我与猫老师（QQ 123456789）继续验收发布清单。",
      [source]
    )).toMatchObject({ eligible: true, reasons: [] });
  });

  it("keeps metadata identity pairs scoped to their source record", () => {
    const sources = [
      {
        fact: "我与猫老师继续验收。",
        userIds: ["123456"],
        addressNames: ["猫老师"]
      },
      {
        fact: "我与狗老师继续验收。",
        userIds: ["456789"],
        addressNames: ["狗老师"]
      }
    ];

    expect(evaluateDreamCanonicalFact(
      "我与猫老师（456789）和狗老师（123456）继续验收。",
      sources
    )).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["unsupported_identity"])
    });
    expect(evaluateDreamCanonicalFact(
      "我与猫老师（123456）和狗老师（456789）继续验收。",
      sources
    )).toMatchObject({ eligible: true, reasons: [] });
  });

  it("fails closed for ambiguous multi-identity metadata without explicit pairs", () => {
    const ambiguous = {
      fact: "我与猫老师和狗老师继续验收。",
      userIds: ["123456", "456789"],
      addressNames: ["猫老师", "狗老师"]
    };
    const explicit = {
      ...ambiguous,
      fact: "我与猫老师（QQ 123456）和狗老师（QQ号：456789）继续验收。"
    };

    expect(evaluateDreamCanonicalFact(
      "我与猫老师（123456）和狗老师（456789）继续验收。",
      [ambiguous]
    )).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["unsupported_identity"])
    });
    expect(evaluateDreamCanonicalFact(
      "我与猫老师（123456）和狗老师（456789）继续验收。",
      [explicit]
    )).toMatchObject({ eligible: true, reasons: [] });
  });

  it("allows any grounded alias when one source has one QQ and multiple names", () => {
    expect(evaluateDreamCanonicalFact(
      "我与老师（123456）继续验收。",
      [{
        fact: "我与老师继续验收。",
        userIds: ["123456"],
        addressNames: ["猫老师", "老师"]
      }]
    )).toMatchObject({ eligible: true, reasons: [] });
  });
});
