import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readUserTestCaseDocument,
  replaceUserTestCaseDocumentDefinition
} from "./caseDocument.js";
import type {
  DreamUserTestInput,
  UserTestCase
} from "./contracts.js";
import { validateSanitizedBranchSample } from "./sanitizedSample.js";
import { rebaseDreamTemplateToFixture } from "./timeline.js";

const SANITIZED_REDACTION_MARKER = "[sensitive-content-redacted]";
const EMPTY_SANITIZED_AIR = [
  "# 场域知识",
  "",
  "## 使用边界",
  "",
  "当前没有可用于本次脱敏夹具的场域边界。",
  "",
  "## 场域约定",
  "",
  "当前没有可用于本次脱敏夹具的场域约定。"
].join("\n");

export async function deriveBranchCaseFromSample(input: {
  samplePath: string;
  templatePath: string;
  outputRoot: string;
  outputName: string;
  confirmReviewedSanitizedSample: boolean;
}) {
  if (!input.confirmReviewedSanitizedSample) {
    throw new Error("USER_TEST_SANITIZED_SAMPLE_REVIEW_REQUIRED");
  }
  const [samplePath, templatePath, outputRoot] = await Promise.all([
    requireRegularFile(input.samplePath, "USER_TEST_SAMPLE_INPUT_INVALID"),
    requireRegularFile(input.templatePath, "USER_TEST_TEMPLATE_INPUT_INVALID"),
    requireDirectory(input.outputRoot, "USER_TEST_DERIVE_OUTPUT_ROOT_INVALID")
  ]);
  const outputName = safeRelativeFileName(input.outputName);
  const outputPath = path.join(outputRoot, outputName);
  if (outputPath === samplePath || outputPath === templatePath) {
    throw new Error("USER_TEST_DERIVE_OUTPUT_OVERLAPS_INPUT");
  }
  const [sampleSource, template] = await Promise.all([
    fs.readFile(samplePath, "utf8"),
    readUserTestCaseDocument(templatePath)
  ]);
  const sample = validateSanitizedBranchSample(parseJson(sampleSource));
  if (template.case.kind !== "dream") {
    throw new Error("USER_TEST_DERIVE_BRANCH_TEMPLATE_REQUIRED");
  }
  const nextCase: UserTestCase = {
    ...template.case,
    input: dreamInput(sample.fixture, template.case.input as DreamUserTestInput)
  };
  const output = replaceUserTestCaseDocumentDefinition(template.source, nextCase);
  await writeExclusiveRegularFile(outputPath, output);
  return {
    outputPath,
    caseId: nextCase.id,
    kind: nextCase.kind,
    sampleDigest: sample.integrity.payloadSha256,
    documentDigest: crypto.createHash("sha256").update(output).digest("hex")
  };
}

function dreamInput(
  fixture: ReturnType<typeof validateSanitizedBranchSample>["fixture"],
  templateInput: DreamUserTestInput
): DreamUserTestInput {
  if (!fixture.workingMemory.length || !fixture.conversations.length) {
    throw new Error("USER_TEST_DERIVE_DREAM_SAMPLE_EMPTY");
  }
  const templateTimeline = rebaseDreamTemplateToFixture(templateInput, fixture.now);
  return {
    timePolicy: templateInput.timePolicy,
    now: fixture.now,
    workingMemory: fixture.workingMemory,
    longTerm: fixture.longTerm,
    userProfiles: fixture.userProfiles,
    persona: {
      ...fixture.persona,
      air: fixture.persona.air.trim() === SANITIZED_REDACTION_MARKER
        ? EMPTY_SANITIZED_AIR
        : fixture.persona.air
    },
    conversations: fixture.conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map(({
        imageCount: _imageCount,
        quoteCount: _quoteCount,
        ...message
      }) => message)
    })),
    activeTasks: templateTimeline.activeTasks,
    directorSchedule: templateTimeline.directorSchedule
  };
}

async function requireRegularFile(value: string, code: string) {
  if (!path.isAbsolute(value)) throw new Error(code);
  const resolved = path.resolve(value);
  const stats = await fs.lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(code);
  return await fs.realpath(resolved);
}

async function requireDirectory(value: string, code: string) {
  if (!path.isAbsolute(value)) throw new Error(code);
  const resolved = path.resolve(value);
  const stats = await fs.lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(code);
  return await fs.realpath(resolved);
}

function safeRelativeFileName(value: string) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    path.basename(normalized) !== normalized ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error("USER_TEST_DERIVE_OUTPUT_NAME_INVALID");
  }
  return normalized;
}

async function writeExclusiveRegularFile(filePath: string, content: string) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseJson(source: string) {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("USER_TEST_SANITIZED_SAMPLE_INVALID");
  }
}
