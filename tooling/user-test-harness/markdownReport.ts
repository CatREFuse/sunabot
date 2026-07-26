import fs from "node:fs/promises";
import path from "node:path";
import type { SealedUserTestReport, UserTestRunReport } from "./contracts.js";

export async function appendMarkdownReport(input: {
  reportPath: string;
  targetPath: string;
  suite: string;
}) {
  const report = JSON.parse(await fs.readFile(input.reportPath, "utf8")) as
    UserTestRunReport | SealedUserTestReport;
  const target = path.resolve(input.targetPath);
  const lock = `${target}.lock`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await acquireLock(lock);
  try {
    const text = renderReport(report, input.suite);
    const existing = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const heading = `## ${input.suite} · ${report.caseId}`;
    const run = `- run: \`${report.runId}\``;
    if (existing.includes(heading) && existing.includes(run)) return;
    await fs.appendFile(target, text, { encoding: "utf8", mode: 0o600 });
  } finally {
    await fs.rmdir(lock);
  }
}

function renderReport(report: UserTestRunReport | SealedUserTestReport, suite: string) {
  const failed = report.execution.assertions.filter((assertion) => !assertion.passed);
  const review = report.quality.status === "reviewed" ? report.quality.review : undefined;
  const lines = [
    "",
    `## ${suite} · ${report.caseId}`,
    "",
    `- run: \`${report.runId}\``,
    `- source revision: \`${report.sourceRevision}\``,
    `- execution: \`${report.execution.status}\``,
    `- quality: \`${report.quality.status}\``,
    `- verdict: \`${report.verdict}\``,
    `- tools: ${report.observation.tools.length ? report.observation.tools.map((tool) => `\`${tool}\``).join(", ") : "none"}`,
    `- tool calls: ${report.observation.toolCalls.length
      ? report.observation.toolCalls.map((call) => `\`${call.name}:${call.status}\``).join(", ")
      : "none"}`,
    `- outbound: ${report.observation.outbound.length}`,
    `- failed assertions: ${failed.length}`,
    ...(report.execution.error ? [`- error: ${report.execution.error}`] : []),
    ...(review ? [
      `- reviewer: ${review.reviewer}`,
      `- review summary: ${review.summary}`,
      ...review.criteria.map((criterion) => (
        `- ${criterion.id}: ${criterion.score}/5 — ${criterion.evidence}`
      ))
    ] : []),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

async function acquireLock(lockPath: string) {
  const started = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > 10_000) throw new Error("USER_TEST_REPORT_LOCK_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
