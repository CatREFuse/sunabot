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
  MemoryCompressionUserTestInput,
  UserTestCase
} from "./contracts.js";
import { validateSanitizedBranchSample } from "./sanitizedSample.js";
import { rebaseDreamTemplateToFixture } from "./timeline.js";

export async function deriveBranchCaseFromSample(input: {
  samplePath: string;
  templatePath: string;
  outputRoot: string;
  outputName: string;
  conversationId?: string;
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
  if (template.case.kind === "conversation") {
    throw new Error("USER_TEST_DERIVE_BRANCH_TEMPLATE_REQUIRED");
  }
  const nextCase: UserTestCase = {
    ...template.case,
    input: template.case.kind === "dream"
      ? dreamInput(sample.fixture, template.case.input as DreamUserTestInput)
      : memoryCompressionInput(
          sample.fixture,
          template.case.input as MemoryCompressionUserTestInput,
          input.conversationId
        )
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
    persona: fixture.persona,
    conversations: fixture.conversations,
    activeTasks: templateTimeline.activeTasks,
    directorSchedule: templateTimeline.directorSchedule
  };
}

function memoryCompressionInput(
  fixture: ReturnType<typeof validateSanitizedBranchSample>["fixture"],
  templateInput: MemoryCompressionUserTestInput,
  requestedConversationId?: string
): MemoryCompressionUserTestInput {
  const conversation = requestedConversationId
    ? fixture.conversations.find(({ id }) => id === requestedConversationId)
    : fixture.conversations[0];
  if (!conversation?.messages.length) {
    throw new Error("USER_TEST_DERIVE_CONVERSATION_NOT_FOUND");
  }
  return {
    timePolicy: templateInput.timePolicy,
    now: fixture.now,
    workingMemory: fixture.workingMemory,
    longTerm: fixture.longTerm,
    userProfiles: fixture.userProfiles,
    conversation: {
      id: conversation.id,
      scope: conversation.scope,
      title: conversation.title,
      userId: conversation.userId,
      ...(conversation.groupId == null ? {} : { groupId: conversation.groupId })
    },
    messages: conversation.messages.map((message) => ({
      ...message,
      imageCount: 0,
      quoteCount: 0
    }))
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
