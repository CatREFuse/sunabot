import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentSkillFileManifestEntry,
  AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  SKILL_REVIEW_MAX_SCRIPT_BYTES,
  SKILL_REVIEW_MAX_TOTAL_SCRIPT_BYTES,
  SKILL_REVIEW_MAX_TEXT_BYTES,
  SKILL_REVIEW_MAX_TOTAL_TEXT_BYTES,
  type SkillReviewPreparation,
  type SkillReviewScriptEvidence,
  type SkillReviewTextEvidence
} from "../../services/extensions/public.js";
import type { PinnedDirectoryIdentity } from "./agentExtensionSecureFs.js";
import { storeError } from "./agentExtensionSecureFs.js";
import { bindSkillDirectory, verifyBoundSkillDirectory } from "./agentSkillSafeMutation.js";
import type { SkillArchiveLimits } from "./skillArchive.js";

const BINARY_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".mp3", ".mp4", ".mov", ".ogg", ".otf",
  ".pdf", ".png", ".tar", ".tgz", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2", ".zip"
]);

export async function prepareSkillReviewPackage(input: {
  agentId: string;
  record: AgentSkillRecord;
  indexRevision: string;
  directory: string;
  skillsIdentity: PinnedDirectoryIdentity;
  archiveLimits?: SkillArchiveLimits;
  beforeFileOpen?: (absolute: string, relative: string) => void | Promise<void>;
}): Promise<SkillReviewPreparation> {
  const bound = await bindSkillDirectory(
    input.directory,
    input.record.digestSha256,
    input.archiveLimits,
    input.skillsIdentity
  );
  if (bound.evidence.name !== input.record.name || bound.evidence.digestSha256 !== input.record.digestSha256) {
    packageChanged();
  }
  const scriptFiles = bound.evidence.files.filter((file) => file.path.startsWith("scripts/"));
  let total = 0;
  for (const file of scriptFiles) {
    if (file.bytes > SKILL_REVIEW_MAX_SCRIPT_BYTES || total > SKILL_REVIEW_MAX_TOTAL_SCRIPT_BYTES - file.bytes) {
      throw storeError(409, "SKILL_REVIEW_SCRIPT_LIMIT", "Skill 脚本超过安全审查上限。");
    }
    total += file.bytes;
  }
  const scripts: SkillReviewScriptEvidence[] = [];
  const texts: SkillReviewTextEvidence[] = [];
  const allocated = new Set<Buffer>();
  let totalTextBytes = 0;
  try {
    for (const file of bound.evidence.files) {
      if (BINARY_EXTENSIONS.has(path.extname(file.path).toLowerCase())) continue;
      if (file.bytes > SKILL_REVIEW_MAX_TEXT_BYTES || totalTextBytes > SKILL_REVIEW_MAX_TOTAL_TEXT_BYTES - file.bytes) {
        throw storeError(409, "SKILL_REVIEW_TEXT_LIMIT", "Skill 文本内容超过安全审查上限。");
      }
      const content = await readPinnedFile(bound.path, file, input.beforeFileOpen);
      allocated.add(content);
      try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch {
        throw storeError(409, "SKILL_REVIEW_TEXT_INVALID", "Skill 文本内容编码无效。");
      }
      totalTextBytes += file.bytes;
      const text: SkillReviewTextEvidence = { ...file, content, kind: textKind(file.path) };
      texts.push(text);
      if (file.path.startsWith("scripts/")) scripts.push({ ...file, content });
    }
    const after = await verifyBoundSkillDirectory(bound, input.record.digestSha256, input.archiveLimits);
    if (!sameManifest(bound.evidence.files, after.files)) packageChanged();
  } catch (error) {
    for (const content of allocated) content.fill(0);
    throw error;
  }
  return {
    schemaVersion: 1,
    agentId: input.agentId,
    skillId: input.record.id,
    indexRevision: input.indexRevision,
    digestSha256: input.record.digestSha256,
    files: bound.evidence.files.map((file) => ({ ...file })),
    scripts,
    texts,
    allowedTools: [...bound.evidence.allowedTools],
    riskEvidence: structuredClone(bound.evidence.riskEvidence)
  };
}

export async function verifySkillReviewPackage(input: {
  record: AgentSkillRecord;
  directory: string;
  skillsIdentity: PinnedDirectoryIdentity;
  expectedFiles: AgentSkillFileManifestEntry[];
  archiveLimits?: SkillArchiveLimits;
}) {
  const bound = await bindSkillDirectory(
    input.directory,
    input.record.digestSha256,
    input.archiveLimits,
    input.skillsIdentity
  );
  if (bound.evidence.name !== input.record.name || !sameManifest(input.expectedFiles, bound.evidence.files)) {
    packageChanged();
  }
  const after = await verifyBoundSkillDirectory(bound, input.record.digestSha256, input.archiveLimits);
  if (!sameManifest(input.expectedFiles, after.files)) packageChanged();
  return after;
}

async function readPinnedFile(
  root: string,
  file: AgentSkillFileManifestEntry,
  beforeOpen?: (absolute: string, relative: string) => void | Promise<void>
): Promise<Buffer> {
  const absolute = path.join(root, ...file.path.split("/"));
  const expectedRealPath = absolute;
  const before = await pinnedRegularFile(absolute, expectedRealPath, file.bytes);
  await beforeOpen?.(absolute, file.path);
  const preOpen = await pinnedRegularFile(absolute, expectedRealPath, file.bytes);
  assertSameFile(before, preOpen);
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let content: Buffer | undefined;
  let probe: Buffer | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegular(opened, file.bytes);
    assertSameFile(preOpen, opened);
    content = Buffer.alloc(file.bytes);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) packageChanged();
      offset += bytesRead;
    }
    probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, content.length)).bytesRead !== 0) packageChanged();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await pinnedRegularFile(absolute, expectedRealPath, file.bytes);
    assertSameFile(opened, after);
    assertSameFile(after, pathAfter);
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) packageChanged();
  } catch (error) {
    failed = true;
    failure = error;
    content?.fill(0);
  }
  try {
    await handle.close();
  } catch {
    content?.fill(0);
    probe?.fill(0);
    packageChanged();
  }
  probe?.fill(0);
  if (failed) throw failure;
  return content!;
}

async function pinnedRegularFile(filePath: string, expectedRealPath: string, expectedBytes: number) {
  let stat: BigIntStats;
  let realPath: string;
  try {
    [stat, realPath] = await Promise.all([
      fs.lstat(filePath, { bigint: true }),
      fs.realpath(filePath)
    ]);
  } catch {
    packageChanged();
  }
  assertRegular(stat, expectedBytes);
  if (realPath !== expectedRealPath) packageChanged();
  return stat;
}

function assertRegular(stat: BigIntStats, expectedBytes: number) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size !== BigInt(expectedBytes)) {
    packageChanged();
  }
}

function assertSameFile(left: BigIntStats, right: BigIntStats) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size ||
      left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs || left.nlink !== right.nlink) {
    packageChanged();
  }
}

function sameManifest(left: AgentSkillFileManifestEntry[], right: AgentSkillFileManifestEntry[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function packageChanged(): never {
  throw storeError(409, "SKILL_PACKAGE_CHANGED", "Skill 目录在安全审查期间发生变化。");
}

function textKind(filePath: string): SkillReviewTextEvidence["kind"] {
  if (filePath === "SKILL.md") return "instructions";
  if (filePath.startsWith("references/")) return "reference";
  if (filePath.startsWith("scripts/")) return "script";
  if (filePath === "agents/openai.yaml" || /(?:^|\/)(?:config|settings)\.[^/]+$/iu.test(filePath)) return "config";
  return "text";
}
