#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArguments(rest);
  if (command === "validate") {
    const { readUserTestCaseDocument } = await import("./caseDocument.js");
    const document = await readUserTestCaseDocument(required(args, "case"));
    console.log(`user test case valid: ${document.case.id} (${document.case.kind})`);
    return;
  }
  if (command === "prepare") {
    const { prepareUserTestWorkspace } = await import("./workspace.js");
    const prepared = await prepareUserTestWorkspace({
      source: required(args, "source"),
      destination: required(args, "destination"),
      confirmCredentialCopy: flag(args, "confirm-copy-provider-credential"),
      agentId: optional(args, "agent")
    });
    console.log(`isolated user test workspace ready: ${prepared.destination}`);
    console.log(`agent: ${prepared.agentId}`);
    console.log(`provider: ${prepared.provider.id} / ${prepared.provider.kind} / ${prepared.provider.model}`);
    return;
  }
  if (command === "sample") {
    const { sampleBranchFixture } = await import("./sample.js");
    const result = await sampleBranchFixture({
      sourceWorkspace: required(args, "source"),
      agentId: required(args, "agent"),
      outputPath: required(args, "output"),
      conversationLimit: optionalInteger(args, "conversation-limit"),
      messageLimit: optionalInteger(args, "message-limit"),
      memoryLimit: optionalInteger(args, "memory-limit"),
      includeWorkingMemoryConversations: flag(args, "include-working-memory-conversations")
    });
    console.log(`redacted fixture sample ready: ${result.outputPath}`);
    console.log(`digest: ${result.digest}`);
    console.log(`counts: ${JSON.stringify(result.counts)}`);
    return;
  }
  if (command === "derive-branch-case") {
    const { deriveBranchCaseFromSample } = await import("./deriveBranchCase.js");
    const result = await deriveBranchCaseFromSample({
      samplePath: required(args, "sample"),
      templatePath: required(args, "template"),
      outputRoot: required(args, "output-root"),
      outputName: required(args, "output"),
      conversationId: optional(args, "conversation"),
      confirmReviewedSanitizedSample: flag(args, "confirm-reviewed-sanitized-sample")
    });
    console.log(`derived user test case ready: ${result.outputPath}`);
    console.log(`case: ${result.caseId} / ${result.kind}`);
    console.log(`sample digest: ${result.sampleDigest}`);
    console.log(`document digest: ${result.documentDigest}`);
    return;
  }
  if (command === "run") {
    requireProviderExecutionGate(args);
    process.env.SUNABOT_WORKSPACE = path.resolve(required(args, "workspace"));
    process.env.NODE_ENV = "production";
    const [{ assertUserTestWorkspace, claimUserTestWorkspaceCase }, { readUserTestCaseDocument }] = await Promise.all([
      import("./workspace.js"),
      import("./caseDocument.js")
    ]);
    const workspace = await assertUserTestWorkspace(process.env.SUNABOT_WORKSPACE);
    const document = await readUserTestCaseDocument(required(args, "case"));
    await claimUserTestWorkspaceCase({
      workspace,
      caseId: document.case.id,
      caseDigest: document.digest
    });
    const output = path.resolve(required(args, "output"));
    const { runRuntimeUserTest } = await import("./runtimeDriver.js");
    const report = await runRuntimeUserTest(document.case, document.digest);
    await writeNewJson(output, report);
    console.log(`user test run: ${report.caseId} / ${report.execution.status} / ${report.verdict}`);
    console.log(`report: ${output}`);
    if (report.execution.status !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "seal") {
    const { sealUserTestReport } = await import("./review.js");
    const sealed = await sealUserTestReport(
      required(args, "run"),
      required(args, "review"),
      required(args, "output")
    );
    console.log(`user test sealed: ${sealed.caseId} / ${sealed.verdict}`);
    if (sealed.verdict !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "gate") {
    const { gateUserTestReports } = await import("./review.js");
    const reports = values(args, "report");
    await gateUserTestReports(reports);
    console.log(`user test gate passed: ${reports.length} report(s)`);
    return;
  }
  if (command === "release-gate") {
    const { gateUserTestReleaseManifest } = await import("./releaseGate.js");
    const result = await gateUserTestReleaseManifest(required(args, "manifest"));
    console.log(
      `user test release gate passed: ${result.suiteId} / ${result.cases.length} case(s) / ${result.sourceRevision}`
    );
    return;
  }
  if (command === "append") {
    const { appendMarkdownReport } = await import("./markdownReport.js");
    await appendMarkdownReport({
      reportPath: required(args, "report"),
      targetPath: required(args, "target"),
      suite: required(args, "suite")
    });
    console.log(`user test markdown appended: ${required(args, "target")}`);
    return;
  }
  throw new Error(
    "usage: user-test <validate|prepare|sample|derive-branch-case|run|seal|gate|release-gate|append> [options]"
  );
}

type ParsedArguments = Map<string, string[]>;

function parseArguments(argv: string[]) {
  const result: ParsedArguments = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`unknown argument: ${item}`);
    const equals = item.indexOf("=");
    const name = item.slice(2, equals < 0 ? undefined : equals);
    const inline = equals < 0 ? undefined : item.slice(equals + 1);
    const next = inline ?? (
      argv[index + 1] && !argv[index + 1]!.startsWith("--")
        ? argv[++index]
        : "true"
    );
    result.set(name, [...(result.get(name) ?? []), next!]);
  }
  return result;
}

function required(args: ParsedArguments, name: string) {
  const value = args.get(name)?.at(-1)?.trim();
  if (!value || value === "true") throw new Error(`missing --${name}`);
  return value;
}

function values(args: ParsedArguments, name: string) {
  const result = (args.get(name) ?? []).map((value) => value.trim()).filter(Boolean);
  if (!result.length) throw new Error(`missing --${name}`);
  return result;
}

function flag(args: ParsedArguments, name: string) {
  return args.get(name)?.at(-1) === "true";
}

function optional(args: ParsedArguments, name: string) {
  const value = args.get(name)?.at(-1)?.trim();
  return !value || value === "true" ? undefined : value;
}

function optionalInteger(args: ParsedArguments, name: string) {
  const value = args.get(name)?.at(-1);
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid --${name}`);
  return parsed;
}

function requireProviderExecutionGate(args: ParsedArguments) {
  if (!flag(args, "execute-provider") || process.env.SUNABOT_USER_TEST_ALLOW_PROVIDER !== "1") {
    throw new Error(
      "live harness requires --execute-provider and SUNABOT_USER_TEST_ALLOW_PROVIDER=1"
    );
  }
}

async function writeNewJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
