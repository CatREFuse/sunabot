import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  SealedUserTestReport,
  UserTestReleaseManifest
} from "./contracts.js";
import { readUserTestCaseDocument } from "./caseDocument.js";
import { validateSealedUserTestReport } from "./review.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function gateUserTestReleaseManifest(
  manifestPath: string,
  repositoryRoot = REPOSITORY_ROOT
) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = validateManifest(
    JSON.parse(await fs.readFile(absoluteManifestPath, "utf8"))
  );
  const sourceRevision = await currentSourceRevision(repositoryRoot);
  if (manifest.sourceRevision !== sourceRevision) {
    throw new Error("USER_TEST_RELEASE_REVISION_MISMATCH");
  }
  const base = path.dirname(absoluteManifestPath);
  const seenCaseIds = new Set<string>();
  const results = [];
  for (const entry of manifest.cases) {
    const document = await readUserTestCaseDocument(resolveManifestPath(base, entry.caseDocument));
    if (seenCaseIds.has(document.case.id)) throw new Error("USER_TEST_RELEASE_CASE_DUPLICATE");
    seenCaseIds.add(document.case.id);
    const reports = await Promise.all(entry.reports.map(async (reportPath) => (
      validateSealedUserTestReport(
        JSON.parse(
          await fs.readFile(resolveManifestPath(base, reportPath), "utf8")
        ) as SealedUserTestReport
      )
    )));
    const runIds = new Set<string>();
    const reviewers = new Set<string>();
    for (const report of reports) {
      if (
        report.caseId !== document.case.id ||
        report.caseDigest !== document.digest ||
        report.sourceRevision !== sourceRevision ||
        report.verdict !== "pass"
      ) {
        throw new Error(`USER_TEST_RELEASE_REPORT_INVALID:${document.case.id}`);
      }
      if (runIds.has(report.runId)) {
        throw new Error(`USER_TEST_RELEASE_RUN_DUPLICATE:${document.case.id}`);
      }
      runIds.add(report.runId);
      const reviewer = report.quality.review.reviewer.trim();
      if (!reviewer || reviewers.has(reviewer)) {
        throw new Error(`USER_TEST_RELEASE_REVIEWER_DUPLICATE:${document.case.id}`);
      }
      reviewers.add(reviewer);
    }
    if (
      runIds.size < entry.minimumIndependentRuns ||
      reviewers.size < entry.minimumIndependentRuns
    ) {
      throw new Error(`USER_TEST_RELEASE_QUORUM_MISSING:${document.case.id}`);
    }
    results.push({
      caseId: document.case.id,
      runs: runIds.size,
      reviewers: reviewers.size
    });
  }
  return {
    suiteId: manifest.suiteId,
    sourceRevision,
    cases: results
  };
}

function validateManifest(value: unknown): UserTestReleaseManifest {
  const manifest = record(value, "USER_TEST_RELEASE_MANIFEST_INVALID");
  exactKeys(manifest, ["schemaVersion", "suiteId", "sourceRevision", "cases"]);
  if (manifest.schemaVersion !== 1) throw new Error("USER_TEST_RELEASE_MANIFEST_INVALID");
  const suiteId = text(manifest.suiteId, "USER_TEST_RELEASE_MANIFEST_INVALID");
  const sourceRevision = text(manifest.sourceRevision, "USER_TEST_RELEASE_MANIFEST_INVALID");
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    throw new Error("USER_TEST_RELEASE_MANIFEST_INVALID");
  }
  const cases = array(manifest.cases, "USER_TEST_RELEASE_MANIFEST_INVALID").map((value) => {
    const entry = record(value, "USER_TEST_RELEASE_MANIFEST_INVALID");
    exactKeys(entry, ["caseDocument", "reports", "minimumIndependentRuns"]);
    const reports = array(entry.reports, "USER_TEST_RELEASE_MANIFEST_INVALID")
      .map((item) => text(item, "USER_TEST_RELEASE_MANIFEST_INVALID"));
    const minimumIndependentRuns = Number(entry.minimumIndependentRuns);
    if (
      !reports.length ||
      new Set(reports).size !== reports.length ||
      !Number.isSafeInteger(minimumIndependentRuns) ||
      minimumIndependentRuns < 1 ||
      minimumIndependentRuns > 8
    ) {
      throw new Error("USER_TEST_RELEASE_MANIFEST_INVALID");
    }
    return {
      caseDocument: text(entry.caseDocument, "USER_TEST_RELEASE_MANIFEST_INVALID"),
      reports,
      minimumIndependentRuns
    };
  });
  if (!cases.length) throw new Error("USER_TEST_RELEASE_MANIFEST_INVALID");
  return {
    schemaVersion: 1,
    suiteId,
    sourceRevision,
    cases
  };
}

function resolveManifestPath(base: string, configured: string) {
  return path.resolve(base, configured);
}

async function currentSourceRevision(repositoryRoot: string) {
  const result = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  const revision = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("USER_TEST_RELEASE_REVISION_INVALID");
  }
  return revision;
}

function record(value: unknown, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string) {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function text(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const expected = new Set(keys);
  if (
    Object.keys(value).some((key) => !expected.has(key)) ||
    keys.some((key) => !(key in value))
  ) {
    throw new Error("USER_TEST_RELEASE_MANIFEST_INVALID");
  }
}
