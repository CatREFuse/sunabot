import { normalizeText } from "../domain/normalizers.js";

export type DreamCanonicalFactRejectionReason = "invalid_fact";

export interface DreamCanonicalFactResult {
  eligible: boolean;
  reasons: DreamCanonicalFactRejectionReason[];
  sourceBigramCoverage: number;
}

export type DreamCanonicalFactSource = Record<string, unknown>;

/**
 * Retained for API compatibility. Canonical memory prose no longer has a
 * host-side lexical coverage threshold.
 */
export const DREAM_CANONICAL_MIN_SOURCE_BIGRAM_COVERAGE = 0;

export function evaluateDreamCanonicalFact(
  canonicalFact: unknown,
  sources: readonly DreamCanonicalFactSource[]
): DreamCanonicalFactResult {
  const eligible = Boolean(normalizeText(canonicalFact)) && sources.length > 0;
  return {
    eligible,
    reasons: eligible ? [] : ["invalid_fact"],
    sourceBigramCoverage: eligible ? 1 : 0
  };
}
