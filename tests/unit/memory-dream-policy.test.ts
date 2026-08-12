// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_ARCHIVE_MIN_DORMANCY_DAYS,
  evaluateDreamArchiveCandidate,
  type DreamLongTermArchiveCandidate
} from "../../services/memory/dream/public.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

describe("Dream long-term forgetting policy", () => {
  it("archives low-value trivia after sufficient dormancy even when it was recalled in the distant past", () => {
    expect(evaluateDreamArchiveCandidate(candidate({
      recallCount: 2,
      distinctRecallDays: 2,
      lastRecalledAt: "2026-01-01T00:00:00.000Z"
    }), NOW)).toEqual({ eligible: true, reasons: [] });
  });

  it("uses the latest successful recall as the dormancy anchor", () => {
    const result = evaluateDreamArchiveCandidate(candidate({
      recallCount: 2,
      distinctRecallDays: 2,
      lastRecalledAt: "2026-05-01T00:00:00.000Z"
    }), NOW);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("dormancy_too_short");
  });

  it("counts independent recall days without making repeated same-day recall immortal", () => {
    const repeatedSameDay = evaluateDreamArchiveCandidate(candidate({
      recallCount: 100,
      distinctRecallDays: 1,
      lastRecalledAt: "2026-01-01T00:00:00.000Z"
    }), NOW);
    const repeatedAcrossDays = evaluateDreamArchiveCandidate(candidate({
      recallCount: 6,
      distinctRecallDays: 6,
      lastRecalledAt: "2026-01-01T00:00:00.000Z"
    }), NOW);

    expect(repeatedSameDay.eligible).toBe(true);
    expect(repeatedAcrossDays).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["dormancy_too_short"])
    });
  });

  it("uses tracking age for never-recalled details and keeps important or protected facts", () => {
    expect(evaluateDreamArchiveCandidate(candidate({
      recallCount: 0,
      distinctRecallDays: 0,
      lastRecalledAt: null,
      trackingStartedAt: new Date(
        NOW.getTime() - (DREAM_ARCHIVE_MIN_DORMANCY_DAYS - 1) * 24 * 60 * 60_000
      ).toISOString()
    }), NOW).reasons).toContain("dormancy_too_short");

    expect(evaluateDreamArchiveCandidate(candidate({ importance: 0.9 }), NOW).reasons)
      .toContain("importance_too_high");
    expect(evaluateDreamArchiveCandidate(candidate({ protectedFromDream: true }), NOW).reasons)
      .toContain("protected");
    expect(evaluateDreamArchiveCandidate(candidate({ hasActiveReferences: true }), NOW).reasons)
      .toContain("active_reference");
  });

  it("rejects inconsistent recall snapshots", () => {
    expect(evaluateDreamArchiveCandidate(candidate({
      recallCount: 1,
      distinctRecallDays: 2,
      lastRecalledAt: null
    }), NOW)).toEqual({
      eligible: false,
      reasons: ["invalid_candidate"]
    });
  });
});

function candidate(
  override: Partial<DreamLongTermArchiveCandidate> = {}
): DreamLongTermArchiveCandidate {
  return {
    recallCount: 0,
    distinctRecallDays: 0,
    lastRecalledAt: null,
    trackingStartedAt: "2025-01-01T00:00:00.000Z",
    importance: 0.05,
    futureRelevance: 0.05,
    emotionalSalience: 0.05,
    hasActiveReferences: false,
    protectedFromDream: false,
    manuallyPinned: false,
    unique: false,
    ...override
  };
}
