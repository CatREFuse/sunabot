import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXTENSION_ID_PATTERN,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import { MAX_SKILL_ARCHIVE_BYTES } from "../../packages/contracts/extensions/agentExtensionLimits.js";
import {
  prepareRestrictedPaths,
  verifyRestrictedPaths,
  type FrozenRestrictedPath
} from "./bashFilesystemGuard.js";
import type {
  BashAccessMode,
  BashAuditResult,
  BashExecutionBackend
} from "./bashAudit.js";
import { parseBashSingleArgv } from "./bashPolicy.js";
import { isBashConfigurationCurrent } from "./bashToolInput.js";
import {
  blockedResult,
  configurationStaleResult,
  sanitizeAuditResult,
  type WorkspaceBashResult
} from "./bashToolResult.js";

export const BASH_SKILL_REPOSITORY_COMMAND = "sunabot-skill";

export type BashSkillRepositoryCommand =
  | { operation: "install"; archivePath: string; replace: boolean }
  | { operation: "review"; skillId: string }
  | { operation: "enable"; skillId: string }
  | { operation: "status"; skillId: string };

export interface BashSkillRepositoryRecord {
  skillId: string;
  name: string;
  digestSha256: string;
  reviewStatus: "unreviewed" | "approved";
  approvalStatus: "unapproved" | "approved";
  enabled: boolean;
  status: "待审查" | "已批准，待启用" | "已启用";
}

export interface BashSkillRepositoryPort {
  install(input: {
    agentId: string;
    archive: Buffer;
    replace: boolean;
  }): Promise<BashSkillRepositoryRecord>;
  review(input: {
    agentId: string;
    skillId: string;
  }): Promise<BashSkillRepositoryRecord>;
  enable(input: {
    agentId: string;
    skillId: string;
  }): Promise<BashSkillRepositoryRecord>;
  status(input: {
    agentId: string;
    skillId: string;
  }): Promise<BashSkillRepositoryRecord>;
}

export class BashSkillRepositoryCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BashSkillRepositoryCommandError";
  }
}

export function parseBashSkillRepositoryCommand(command: string): BashSkillRepositoryCommand | undefined {
  const parsed = parseBashSingleArgv(command);
  if (!/^sunabot-skill(?:$|[^A-Za-z0-9_-])/u.test(command.trim())) return undefined;
  if (!parsed.argv) invalidArguments();
  const [, operation, ...args] = parsed.argv;
  if (operation === "install") return parseInstallArguments(args);
  if (operation === "review") return { operation, skillId: parseSkillArguments(args, true) };
  if (operation === "enable" || operation === "status") {
    return { operation, skillId: parseSkillArguments(args, false) };
  }
  invalidArguments();
}

export function isBashSkillRepositoryPort(value: unknown): value is BashSkillRepositoryPort {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const port = value as Record<string, unknown>;
  return typeof port.install === "function"
    && typeof port.review === "function"
    && typeof port.enable === "function"
    && typeof port.status === "function";
}

export async function readBashSkillArchive(
  archivePath: string,
  workbenchRoot: string
): Promise<Buffer> {
  const [frozen] = await prepareRestrictedPaths([
    { path: archivePath, role: "read-file" }
  ], workbenchRoot);
  if (!frozen?.target) throw new Error("Skill archive identity is unavailable.");
  await verifyRestrictedPaths([frozen]);
  const handle = await fs.open(
    frozen.targetPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertOpenArchiveIdentity(frozen, before);
    const archive = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertOpenArchiveIdentity(frozen, after);
    if (
      before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || archive.length !== Number(after.size)
    ) throw new Error("Skill archive changed while reading.");
    return archive;
  } finally {
    await handle.close();
  }
}

export async function executeBashSkillRepositoryCommand(input: {
  command: string;
  managed: BashSkillRepositoryCommand;
  agentId: string;
  workbenchRoot: string;
  backend: BashExecutionBackend;
  accessMode: BashAccessMode;
  audit: BashAuditResult;
  repository: BashSkillRepositoryPort;
  abortSignal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<WorkspaceBashResult> {
  if (input.abortSignal?.aborted) return abortedResult(input);
  if (!isBashConfigurationCurrent(input.isCurrent)) return staleResult(input);
  let archive: Buffer | undefined;
  if (input.managed.operation === "install") {
    try {
      archive = await readBashSkillArchive(input.managed.archivePath, input.workbenchRoot);
    } catch {
      return blockedResult(
        input.command,
        input.workbenchRoot,
        input.backend,
        input.accessMode,
        "BASH_SKILL_ARCHIVE_INVALID: Skill archive must remain a single-link regular ZIP inside the Native workbench and stay within 16 MiB.",
        input.audit
      );
    }
  }
  if (input.abortSignal?.aborted) return abortedResult(input);
  if (!isBashConfigurationCurrent(input.isCurrent)) return staleResult(input);
  try {
    const result = input.managed.operation === "install"
      ? await input.repository.install({
          agentId: input.agentId,
          archive: archive!,
          replace: input.managed.replace
        })
      : input.managed.operation === "review"
        ? await input.repository.review({ agentId: input.agentId, skillId: input.managed.skillId })
        : input.managed.operation === "enable"
          ? await input.repository.enable({ agentId: input.agentId, skillId: input.managed.skillId })
          : await input.repository.status({ agentId: input.agentId, skillId: input.managed.skillId });
    return {
      ok: true,
      command: input.command,
      cwd: input.workbenchRoot,
      backend: input.backend,
      accessMode: input.accessMode,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: "",
      audit: sanitizeAuditResult(input.audit, input.workbenchRoot)
    };
  } catch (error) {
    return blockedResult(
      input.command,
      input.workbenchRoot,
      input.backend,
      input.accessMode,
      stableSkillRepositoryError(error),
      input.audit
    );
  }
}

export function projectBashSkillRepositoryRecord(record: AgentSkillRecord): BashSkillRepositoryRecord {
  const reviewStatus = record.riskEvidence.reviewStatus;
  const approvalStatus = record.approval?.status ?? "unapproved";
  return {
    skillId: record.id,
    name: record.name,
    digestSha256: record.digestSha256,
    reviewStatus,
    approvalStatus,
    enabled: record.enabled,
    status: record.enabled
      ? "已启用"
      : reviewStatus === "approved" && approvalStatus === "approved"
        ? "已批准，待启用"
        : "待审查"
  };
}

function parseInstallArguments(args: string[]): Extract<BashSkillRepositoryCommand, { operation: "install" }> {
  let archivePath: string | undefined;
  let replace = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--archive" && archivePath === undefined) {
      archivePath = args[++index];
      continue;
    }
    if (argument === "--replace" && !replace) {
      replace = true;
      continue;
    }
    invalidArguments();
  }
  if (!archivePath || !isSafeArchivePath(archivePath)) invalidArguments();
  return { operation: "install", archivePath, replace };
}

function parseSkillArguments(args: string[], requireApproval: boolean) {
  let skillId: string | undefined;
  let approved = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skill" && skillId === undefined) {
      skillId = args[++index];
      continue;
    }
    if (argument === "--approve" && requireApproval && !approved) {
      approved = true;
      continue;
    }
    invalidArguments();
  }
  if (!skillId || skillId.length > 64 || !EXTENSION_ID_PATTERN.test(skillId) || approved !== requireApproval) {
    invalidArguments();
  }
  return skillId;
}

function isSafeArchivePath(value: string) {
  if (
    value.length > 1_024
    || /[\u0000-\u001F\u007F-\u009F]/u.test(value)
    || path.isAbsolute(value)
    || value.includes("\\")
    || !value.endsWith(".zip")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.length > 0
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertOpenArchiveIdentity(
  frozen: FrozenRestrictedPath,
  stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>
) {
  if (!frozen.target
    || !stat.isFile()
    || stat.dev.toString() !== frozen.target.device
    || stat.ino.toString() !== frozen.target.inode
    || stat.nlink !== 1n
    || stat.size < 1n
    || stat.size > BigInt(MAX_SKILL_ARCHIVE_BYTES)) {
    throw new Error("Skill archive identity or size is invalid.");
  }
}

function abortedResult(input: Parameters<typeof executeBashSkillRepositoryCommand>[0]) {
  return blockedResult(
    input.command,
    input.workbenchRoot,
    input.backend,
    input.accessMode,
    "BASH_EXECUTION_ABORTED: managed command was aborted.",
    input.audit
  );
}

function staleResult(input: Parameters<typeof executeBashSkillRepositoryCommand>[0]) {
  return configurationStaleResult(
    input.command,
    input.workbenchRoot,
    input.backend,
    input.accessMode,
    input.audit
  );
}

function stableSkillRepositoryError(error: unknown) {
  if (error && typeof error === "object") {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    const message = "message" in error ? (error as { message?: unknown }).message : undefined;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) {
      return `${code}: ${typeof message === "string" ? message.slice(0, 1_024) : "Skill repository operation failed."}`;
    }
  }
  return "BASH_SKILL_REPOSITORY_FAILED: Skill repository operation failed.";
}

function invalidArguments(): never {
  throw new BashSkillRepositoryCommandError(
    "BASH_SKILL_REPOSITORY_ARGUMENTS_INVALID",
    "Use install --archive <relative-zip> [--replace], review --skill <skill-id> --approve, enable --skill <skill-id>, or status --skill <skill-id>."
  );
}
