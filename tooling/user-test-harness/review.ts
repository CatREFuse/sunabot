import fs from "node:fs/promises";
import type {
  SealedUserTestReport,
  UserTestQualityReview,
  UserTestRunReport
} from "./contracts.js";

export async function sealUserTestReport(
  runReportPath: string,
  reviewPath: string,
  outputPath: string
) {
  const [run, review] = await Promise.all([
    readJson<UserTestRunReport>(runReportPath),
    readJson<UserTestQualityReview>(reviewPath)
  ]);
  const sealed = validateAndSealUserTestReport(run, review);
  await fs.writeFile(outputPath, `${JSON.stringify(sealed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return sealed;
}

export function validateAndSealUserTestReport(
  run: UserTestRunReport,
  review: UserTestQualityReview
): SealedUserTestReport {
  if (run.schemaVersion !== 1 || review.schemaVersion !== 1) throw new Error("USER_TEST_REPORT_VERSION_INVALID");
  if (
    typeof review.reviewer !== "string" ||
    !review.reviewer.trim() ||
    review.reviewer.trim().length > 128 ||
    typeof review.reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    typeof review.summary !== "string" ||
    !review.summary.trim() ||
    review.summary.trim().length > 4_000
  ) {
    throw new Error("USER_TEST_REVIEW_METADATA_INVALID");
  }
  if (
    !/^[0-9a-f]{64}$/u.test(run.caseDigest) ||
    !/^[0-9a-f]{40}$/u.test(run.sourceRevision)
  ) {
    throw new Error("USER_TEST_REPORT_SOURCE_INVALID");
  }
  if (run.runId !== review.runId || run.caseId !== review.caseId) {
    throw new Error("USER_TEST_REVIEW_BINDING_INVALID");
  }
  const expected = new Map(run.quality.criteria.map((criterion) => [criterion.id, criterion]));
  if (
    review.criteria.length !== expected.size ||
    new Set(review.criteria.map((criterion) => criterion.id)).size !== review.criteria.length
  ) {
    throw new Error("USER_TEST_REVIEW_CRITERIA_INVALID");
  }
  let qualityPassed = true;
  for (const result of review.criteria) {
    const criterion = expected.get(result.id);
    if (!criterion || !Number.isInteger(result.score) || result.score < 1 || result.score > 5) {
      throw new Error("USER_TEST_REVIEW_CRITERIA_INVALID");
    }
    if (!result.evidence.trim()) throw new Error("USER_TEST_REVIEW_EVIDENCE_MISSING");
    if (result.score < criterion.minimumScore) qualityPassed = false;
  }
  const mechanicalPassed = run.execution.status === "passed" &&
    run.execution.assertions.every((assertion) => assertion.passed);
  const requiredVerdict = run.execution.status === "blocked"
    ? "blocked"
    : mechanicalPassed && qualityPassed
      ? "pass"
      : "fail";
  if (review.verdict !== requiredVerdict) throw new Error("USER_TEST_REVIEW_VERDICT_INVALID");
  return {
    ...run,
    quality: { ...run.quality, status: "reviewed", review },
    verdict: requiredVerdict
  };
}

export async function gateUserTestReports(paths: readonly string[]) {
  if (!paths.length) throw new Error("USER_TEST_GATE_REPORTS_MISSING");
  const reports = (await Promise.all(
    paths.map((filePath) => readJson<SealedUserTestReport>(filePath))
  )).map(validateSealedUserTestReport);
  const failures = reports.filter((report) => (
    report.schemaVersion !== 1 ||
    report.quality?.status !== "reviewed" ||
    report.verdict !== "pass" ||
    report.execution.status !== "passed" ||
    report.execution.assertions.some((assertion) => !assertion.passed)
  ));
  if (failures.length) {
    throw new Error(`USER_TEST_GATE_FAILED:${failures.map((report) => report.caseId).join(",")}`);
  }
  return reports;
}

export function validateSealedUserTestReport(
  report: SealedUserTestReport
): SealedUserTestReport {
  if (report.quality?.status !== "reviewed" || !report.quality.review) {
    throw new Error("USER_TEST_SEALED_REPORT_INVALID");
  }
  const run: UserTestRunReport = {
    ...report,
    quality: {
      status: "pending_review",
      criteria: report.quality.criteria
    },
    verdict: report.execution.status === "blocked"
      ? "blocked"
      : report.execution.status === "failed"
        ? "fail"
        : "inconclusive"
  };
  const rebuilt = validateAndSealUserTestReport(run, report.quality.review);
  if (rebuilt.verdict !== report.verdict) throw new Error("USER_TEST_SEALED_REPORT_INVALID");
  return rebuilt;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
