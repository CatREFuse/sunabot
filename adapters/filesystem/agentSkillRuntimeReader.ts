import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseAgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  SKILL_RESOURCE_MAX_READ_BYTES,
  assertSkillActivationResource,
  safeRelativeResourcePath,
  type SkillActivationResource
} from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import type {
  RuntimeSkillReaderPort,
  RuntimeSkillReadResult
} from "../../services/extensions/public.js";
import {
  readJson,
  storeError
} from "./agentExtensionSecureFs.js";
import { AgentExtensionPathGuard } from "./agentExtensionPaths.js";
import { extensionRevision } from "./agentSkillPersistence.js";
import { safeSkillTarget } from "./agentSkillTransaction.js";
import { inspectSkillDirectory, type SkillArchiveLimits } from "./skillArchive.js";

const MAX_SKILL_MARKDOWN_BYTES = 512 * 1024;

export interface AgentSkillRuntimeReaderOptions {
  workspaceRoot: string;
  archiveLimits?: SkillArchiveLimits;
  beforePathOperation?: (operation: string) => void | Promise<void>;
  beforeResourceOpen?: (filePath: string) => void | Promise<void>;
}

export class AgentSkillRuntimeReader implements RuntimeSkillReaderPort {
  private readonly pathGuard: AgentExtensionPathGuard;

  constructor(private readonly options: AgentSkillRuntimeReaderOptions) {
    this.pathGuard = new AgentExtensionPathGuard(options.workspaceRoot, {
      beforePathOperation: options.beforePathOperation
    });
  }

  async read(input: {
    agentId: string;
    skillId: string;
    expectedDigestSha256: string;
  }): Promise<RuntimeSkillReadResult> {
    const paths = await this.pathGuard.paths(input.agentId);
    await this.pathGuard.guard(paths, "runtime-skill-read-start");
    const index = parseAgentSkillIndex(await readJson(paths.skillIndex));
    if (index.revision !== extensionRevision(index.skills)) runtimeInvalid();
    const record = index.skills.find((skill) => skill.id === input.skillId);
    if (!record || !runtimeRecordMatches(record, input.expectedDigestSha256)) runtimeInvalid();
    const directory = safeSkillTarget(paths.skills, record.id);
    const evidence = await inspectSkillDirectory(directory, this.options.archiveLimits);
    if (evidence.digestSha256 !== record.digestSha256 || evidence.name !== record.name) runtimeInvalid();
    const skillFile = path.join(directory, "SKILL.md");
    const instructions = await readPinnedRegularUtf8(skillFile, MAX_SKILL_MARKDOWN_BYTES);
    await this.pathGuard.guard(paths, "runtime-skill-read-finish");
    const after = await inspectSkillDirectory(directory, this.options.archiveLimits);
    if (after.digestSha256 !== evidence.digestSha256) runtimeInvalid();
    return {
      digestSha256: record.digestSha256,
      instructions,
      resources: evidence.files
        .filter((file) => file.path !== "SKILL.md" && file.path !== "agents/openai.yaml")
        .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    };
  }

  async readResource(input: {
    agentId: string;
    skillId: string;
    expectedDigestSha256: string;
    resource: SkillActivationResource;
  }) {
    try {
      const resource = assertSkillActivationResource(input.resource);
      if (!safeRelativeResourcePath(resource.path) || resource.bytes > SKILL_RESOURCE_MAX_READ_BYTES) runtimeInvalid();
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "runtime-skill-resource-start");
      const index = parseAgentSkillIndex(await readJson(paths.skillIndex));
      if (index.revision !== extensionRevision(index.skills)) runtimeInvalid();
      const record = index.skills.find((skill) => skill.id === input.skillId);
      if (!record || !runtimeRecordMatches(record, input.expectedDigestSha256)) runtimeInvalid();
      const directory = safeSkillTarget(paths.skills, record.id);
      const evidence = await inspectSkillDirectory(directory, this.options.archiveLimits);
      if (evidence.digestSha256 !== record.digestSha256 || evidence.name !== record.name) runtimeInvalid();
      const manifest = evidence.files.find((file) => file.path === resource.path);
      if (!manifest || manifest.bytes !== resource.bytes || manifest.sha256 !== resource.sha256) runtimeInvalid();
      const bytes = await readPinnedRegularBytes(
        path.join(directory, ...resource.path.split("/")),
        resource.bytes,
        SKILL_RESOURCE_MAX_READ_BYTES,
        this.options.beforeResourceOpen
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== resource.sha256) runtimeInvalid();
      await this.pathGuard.guard(paths, "runtime-skill-resource-finish");
      const after = await inspectSkillDirectory(directory, this.options.archiveLimits);
      if (after.digestSha256 !== evidence.digestSha256) runtimeInvalid();
      return { bytes, sha256 };
    } catch (error) {
      if (error instanceof Error && error.message === "Skill 运行快照无效。") throw error;
      runtimeInvalid();
    }
  }
}

function runtimeRecordMatches(record: AgentSkillRecord, digest: string) {
  return record.enabled && record.approval?.status === "approved" &&
    record.approval.digestSha256 === digest && record.digestSha256 === digest &&
    record.riskEvidence.reviewStatus === "approved" &&
    record.riskEvidence.reviewedDigestSha256 === digest;
}

async function readPinnedRegularUtf8(filePath: string, maxBytes: number) {
  const content = await readPinnedRegularBytes(filePath, undefined, maxBytes);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!decoded || decoded.includes("\0")) runtimeInvalid();
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message === "Skill 运行快照无效。") throw error;
    runtimeInvalid();
  }
}

async function readPinnedRegularBytes(
  filePath: string,
  expectedBytes: number | undefined,
  maxBytes: number,
  beforeOpen?: (filePath: string) => void | Promise<void>
) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes) ||
      (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))) {
    runtimeInvalid();
  }
  await beforeOpen?.(filePath);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) runtimeInvalid();
    const content = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < content.length) {
      const read = await handle.read(content, offset, content.length - offset, offset);
      if (!read.bytesRead) runtimeInvalid();
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(filePath, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, pathAfter)) runtimeInvalid();
    return content;
  } catch (error) {
    if (error instanceof Error && error.message === "SKILL_RUNTIME_INVALID") throw error;
    runtimeInvalid();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameFile(left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint }) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function runtimeInvalid(): never {
  throw storeError(409, "SKILL_RUNTIME_INVALID", "Skill 运行快照无效。");
}
