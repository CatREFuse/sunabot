import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SkillPackageEvidence } from "../../services/extensions/public.js";
import {
  exists,
  lstatOptional,
  pinDirectoryIdentity,
  verifyPrivatePinnedDirectory,
  refreshPinnedDirectory,
  storeError,
  verifyPinnedDirectory,
  type PinnedDirectoryIdentity
} from "./agentExtensionSecureFs.js";
import { parentBoundRename } from "./parentBoundFs.js";
import { inspectSkillDirectory, type SkillArchiveLimits } from "./skillArchive.js";

export interface BoundSkillDirectory {
  path: string;
  identity: PinnedDirectoryIdentity;
  evidence: SkillPackageEvidence;
}

export interface SkillMoveHooks {
  beforeRename?: () => void | Promise<void>;
  beforeBoundRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
}

export async function bindSkillDirectory(
  directory: string,
  expectedDigest: string,
  limits?: SkillArchiveLimits,
  parentIdentity?: PinnedDirectoryIdentity
): Promise<BoundSkillDirectory> {
  const absolute = path.resolve(directory);
  if (parentIdentity) {
    if (path.dirname(absolute) !== parentIdentity.realPath) skillChanged();
    await verifyPrivatePinnedDirectory(parentIdentity.realPath, parentIdentity);
  }
  const identity = await pinDirectoryIdentity(absolute, absolute);
  const evidence = await inspectSkillDirectory(absolute, limits, {}, identity);
  await verifyPinnedDirectory(absolute, identity);
  if (parentIdentity) await verifyPrivatePinnedDirectory(parentIdentity.realPath, parentIdentity);
  if (evidence.digestSha256 !== expectedDigest) skillChanged();
  return { path: absolute, identity, evidence };
}

export async function moveVerifiedSkillDirectory(input: {
  source: string;
  destination: string;
  expectedDigest: string;
  limits?: SkillArchiveLimits;
  hooks?: SkillMoveHooks;
  parentIdentity?: PinnedDirectoryIdentity;
}) {
  const source = path.resolve(input.source);
  const destination = path.resolve(input.destination);
  if (source === destination) throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 目录移动目标无效。");
  const sourceParent = path.dirname(source);
  const destinationParent = path.dirname(destination);
  if (sourceParent !== destinationParent) {
    throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 目录移动必须位于同一可信父目录。");
  }
  await assertPrivateDirectory(sourceParent);
  const sourceParentIdentity = input.parentIdentity
    ? await verifyPrivatePinnedDirectory(sourceParent, input.parentIdentity)
    : await pinDirectoryIdentity(sourceParent, sourceParent);
  const bound = await bindSkillDirectory(source, input.expectedDigest, input.limits, sourceParentIdentity);
  if (await lstatOptional(destination)) skillChanged();
  await input.hooks?.beforeRename?.();
  await verifyPinnedDirectory(sourceParent, sourceParentIdentity);
  await verifyBoundSkillDirectory(bound, input.expectedDigest, input.limits);
  if (await lstatOptional(destination)) skillChanged();
  const sourceStat = await fs.lstat(source, { bigint: true });
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || sourceStat.dev !== bound.identity.dev ||
      sourceStat.ino !== bound.identity.ino) {
    skillChanged();
  }
  await parentBoundRename({
    source,
    destination,
    parentIdentity: sourceParentIdentity,
    expectedSource: sourceStat,
    hook: { beforeCommand: input.hooks?.beforeBoundRename }
  });
  const refreshedSourceParent = await refreshPinnedDirectory(sourceParent, sourceParentIdentity);
  if (await exists(source)) skillChanged();
  const postRenameIdentity = await pinDirectoryIdentity(destination, destination);
  if (postRenameIdentity.dev !== bound.identity.dev || postRenameIdentity.ino !== bound.identity.ino) {
    skillChanged();
  }
  await input.hooks?.afterRename?.();
  await verifyPinnedDirectory(sourceParent, refreshedSourceParent);
  await verifyPinnedDirectory(destination, postRenameIdentity);
  if (await exists(source)) skillChanged();
  const moved = await bindSkillDirectory(
    destination,
    input.expectedDigest,
    input.limits,
    refreshedSourceParent
  );
  if (moved.identity.dev !== postRenameIdentity.dev || moved.identity.ino !== postRenameIdentity.ino ||
      moved.identity.ctimeNs !== postRenameIdentity.ctimeNs) {
    skillChanged();
  }
  return { ...moved, parentIdentity: refreshedSourceParent };
}

export async function quarantineVerifiedSkillDirectory(input: {
  source: string;
  expectedDigest: string;
  limits?: SkillArchiveLimits;
  prefix?: ".skill-quarantine-" | ".skill-tombstone-";
  hooks?: SkillMoveHooks;
  parentIdentity?: PinnedDirectoryIdentity;
}) {
  const source = path.resolve(input.source);
  if (!(await exists(source))) return null;
  const destination = path.join(
    path.dirname(source),
    `${input.prefix ?? ".skill-quarantine-"}${randomUUID()}`
  );
  return moveVerifiedSkillDirectory({ ...input, source, destination });
}

export async function verifyBoundSkillDirectory(
  bound: BoundSkillDirectory,
  expectedDigest: string,
  limits?: SkillArchiveLimits
) {
  await verifyPinnedDirectory(bound.path, bound.identity);
  const current = await inspectSkillDirectory(bound.path, limits);
  await verifyPinnedDirectory(bound.path, bound.identity);
  if (current.digestSha256 !== expectedDigest) skillChanged();
  return current;
}

function skillChanged(): never {
  throw storeError(409, "SKILL_PACKAGE_CHANGED", "Skill 目录在事务期间发生变化。");
}

async function assertPrivateDirectory(directory: string) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777n) !== 0o700n) {
    throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 事务父目录权限无效。");
  }
}
