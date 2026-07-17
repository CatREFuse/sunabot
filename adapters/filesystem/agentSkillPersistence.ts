import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  compareBinaryText,
  parseAgentSkillIndex,
  type AgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import { sameSkillEvidence } from "./agentExtensionPreview.js";
import {
  exists,
  atomicJson,
  pinDirectoryIdentity,
  readJson,
  refreshPrivatePinnedDirectory,
  storeError,
  syncDirectory,
  verifyPrivatePinnedDirectory,
  type PinnedDirectoryIdentity,
  type AgentExtensionBeforeFileOpen
} from "./agentExtensionSecureFs.js";
import {
  type AgentExtensionPathGuard,
  type AgentExtensionStorePaths
} from "./agentExtensionPaths.js";
import {
  parseSkillRemovalTransaction,
  parseSkillTransaction,
  safeInternalPath,
  safeSkillTarget,
  type SkillRemovalTransaction,
  type SkillTransaction
} from "./agentSkillTransaction.js";
import {
  bindSkillDirectory,
  moveVerifiedSkillDirectory,
  quarantineVerifiedSkillDirectory
} from "./agentSkillSafeMutation.js";
import { parentBoundRename, type ParentBoundWorkerFailureMode } from "./parentBoundFs.js";
import { inspectSkillDirectory, type SkillArchiveLimits } from "./skillArchive.js";

interface SkillPersistenceContext {
  paths: AgentExtensionStorePaths;
  pathGuard: AgentExtensionPathGuard;
  beforeFileOpen?: AgentExtensionBeforeFileOpen;
  archiveLimits?: SkillArchiveLimits;
  beforeRecoveryMutation?: () => void | Promise<void>;
  recoverySkillsIdentity?: PinnedDirectoryIdentity;
}

export async function readSkillIndexFile(
  context: SkillPersistenceContext,
  verifyPackages: boolean
): Promise<AgentSkillIndex> {
  const { paths } = context;
  await verifyRecoverySkills(context);
  if (!(await exists(paths.skillIndex))) {
    return {
      schemaVersion: 1,
      revision: extensionRevision([]),
      skills: []
    };
  }
  const index = parseAgentSkillIndex(await readJson(paths.skillIndex, context.beforeFileOpen));
  await verifyRecoverySkills(context);
  if (index.revision !== extensionRevision([...index.skills].sort((left, right) => compareBinaryText(left.id, right.id)))) {
    throw storeError(409, "SKILL_INDEX_REVISION_MISMATCH", "Skill 索引 revision 无效。");
  }
  if (!verifyPackages) return index;
  for (const record of index.skills) {
    if (!(await packageMatches(path.join(paths.skills, record.id), record, context.archiveLimits))) {
      throw storeError(409, "SKILL_INDEX_MISMATCH", "Skill 索引与文件摘要不一致。");
    }
  }
  return index;
}

export async function recoverSkillTransactions(context: SkillPersistenceContext) {
  const { paths, pathGuard, archiveLimits } = context;
  await pathGuard.guard(paths, "recover-skill-transactions");
  context.recoverySkillsIdentity = pathGuard.directoryIdentity(paths, paths.skills);
  await verifyRecoverySkills(context);
  const entries = await fs.readdir(paths.skills);
  await verifyRecoverySkills(context);
  const installJournals = await Promise.all(entries
    .filter((entry) => /^\.skill-transaction-[a-f0-9-]+\.json$/u.test(entry))
    .sort()
    .map(async (name) => {
      const journalPath = path.join(paths.skills, name);
      await verifyRecoverySkills(context);
      const transaction = parseSkillTransaction(await readJson(journalPath, context.beforeFileOpen));
      await verifyRecoverySkills(context);
      return {
        journalPath,
        transaction
      };
    }));
  const removalJournals = await Promise.all(entries
    .filter((entry) => /^\.skill-remove-transaction-[a-f0-9-]+\.json$/u.test(entry))
    .sort()
    .map(async (name) => {
      const journalPath = path.join(paths.skills, name);
      await verifyRecoverySkills(context);
      const transaction = parseSkillRemovalTransaction(await readJson(journalPath, context.beforeFileOpen));
      await verifyRecoverySkills(context);
      return {
        journalPath,
        transaction
      };
    }));
  await context.beforeRecoveryMutation?.();
  await verifyRecoverySkills(context);
  for (const journal of installJournals) {
    await recoverInstallJournal(context, journal.journalPath, journal.transaction);
  }
  for (const journal of removalJournals) {
    await recoverRemovalJournal(context, journal.journalPath, journal.transaction);
  }
  await verifyRecoverySkills(context);
  await syncDirectory(paths.skills, context.recoverySkillsIdentity);
  await refreshRecoverySkills(context);
  await pathGuard.refresh(paths, { allowChanged: [paths.skills] });
  context.recoverySkillsIdentity = undefined;
}

async function verifyRecoverySkills(context: SkillPersistenceContext) {
  if (!context.recoverySkillsIdentity) return;
  await verifyPrivatePinnedDirectory(context.paths.skills, context.recoverySkillsIdentity);
}

async function refreshRecoverySkills(context: SkillPersistenceContext) {
  if (!context.recoverySkillsIdentity) return;
  context.recoverySkillsIdentity = await refreshPrivatePinnedDirectory(
    context.paths.skills,
    context.recoverySkillsIdentity
  );
}

async function retainRecoveryJournal(
  context: SkillPersistenceContext,
  journalPath: string,
  transaction: SkillTransaction | SkillRemovalTransaction,
  state: "committed" | "rolled_back"
) {
  await verifyRecoverySkills(context);
  const result = await retainTerminalSkillJournal(journalPath, transaction, state, {
    parentIdentity: context.recoverySkillsIdentity
  });
  await refreshRecoverySkills(context);
  return result;
}

async function moveRecoveryDirectory(
  context: SkillPersistenceContext,
  input: Omit<Parameters<typeof moveVerifiedSkillDirectory>[0], "parentIdentity">
) {
  await verifyRecoverySkills(context);
  const result = await moveVerifiedSkillDirectory({
    ...input,
    parentIdentity: context.recoverySkillsIdentity
  });
  await refreshRecoverySkills(context);
  return result;
}

async function quarantineRecoveryDirectory(
  context: SkillPersistenceContext,
  input: Omit<Parameters<typeof quarantineVerifiedSkillDirectory>[0], "parentIdentity">
) {
  await verifyRecoverySkills(context);
  const result = await quarantineVerifiedSkillDirectory({
    ...input,
    parentIdentity: context.recoverySkillsIdentity
  });
  await refreshRecoverySkills(context);
  return result;
}

async function bindRecoveryDirectory(
  context: SkillPersistenceContext,
  directory: string,
  expectedDigest: string,
  limits?: SkillArchiveLimits
) {
  await verifyRecoverySkills(context);
  const result = await bindSkillDirectory(
    directory,
    expectedDigest,
    limits,
    context.recoverySkillsIdentity
  );
  await verifyRecoverySkills(context);
  return result;
}

async function recoverInstallJournal(
  context: SkillPersistenceContext,
  journalPath: string,
  transaction: SkillTransaction
) {
  const { paths, archiveLimits } = context;
  const target = safeSkillTarget(paths.skills, transaction.id);
  const stage = safeInternalPath(paths.skills, transaction.stageName, ".skill-");
  const backup = safeInternalPath(paths.skills, transaction.backupName, `.skill-quarantine-${transaction.id}-`);
  const index = await readSkillIndexFile(context, false);
  const record = index.skills.find((skill) => skill.id === transaction.id);
  if (transaction.state === "committed") {
    if (!record || record.digestSha256 !== transaction.nextDigest) {
      recoveryRequired("已提交的 Skill 安装事务与索引不一致。");
    }
    await requirePackageDigest(target, transaction.nextDigest, archiveLimits, "已提交的 Skill 目标证据缺失。");
    if (transaction.previousDigest) {
      await requirePackageDigest(
        backup,
        transaction.previousDigest,
        archiveLimits,
        "已提交的 Skill 替换事务缺少旧版本隔离证据。"
      );
    } else if (await exists(backup)) {
      recoveryRequired("首次安装事务包含未知旧版本隔离证据。");
    }
    if (await exists(stage)) recoveryRequired("已提交的 Skill 安装事务仍包含暂存目录。");
    await retainRecoveryJournal(context, journalPath, transaction, "committed");
    return;
  }
  if (transaction.state === "rolled_back") {
    if (transaction.previousDigest) {
      if (!record || record.digestSha256 !== transaction.previousDigest) {
        recoveryRequired("已回滚的 Skill 替换事务与索引不一致。");
      }
      await requirePackageDigest(
        target,
        transaction.previousDigest,
        archiveLimits,
        "已回滚的 Skill 替换事务缺少原版本。"
      );
      if (await exists(backup)) recoveryRequired("已回滚的 Skill 替换事务仍包含重复旧版本。");
    } else {
      if (record) recoveryRequired("已回滚的首次安装事务仍存在索引记录。");
      if (await exists(target)) recoveryRequired("已回滚的首次安装事务仍存在目标目录。");
    }
    if (await exists(stage)) {
      await requirePackageDigest(stage, transaction.nextDigest, archiveLimits, "Skill 回滚暂存证据无效。");
    }
    await retainRecoveryJournal(context, journalPath, transaction, "rolled_back");
    return;
  }
  const committed = index.skills.some((skill) =>
    skill.id === transaction.id && skill.digestSha256 === transaction.nextDigest);
  if (committed) {
    await requirePackageDigest(target, transaction.nextDigest, archiveLimits, "已提交的 Skill 目标证据缺失。");
    if (transaction.previousDigest) {
      await requirePackageDigest(
        backup,
        transaction.previousDigest,
        archiveLimits,
        "已提交的 Skill 替换事务缺少旧版本隔离证据。"
      );
    } else if (await exists(backup)) {
      recoveryRequired("首次安装事务包含未知旧版本隔离证据。");
    }
    if (await exists(stage)) recoveryRequired("已提交的 Skill 安装事务仍包含暂存目录。");
    await retainRecoveryJournal(context, journalPath, transaction, "committed");
    return;
  }
  if (await exists(target)) {
    if (await packageHasDigest(target, transaction.nextDigest, archiveLimits)) {
      await quarantineRecoveryDirectory(context, {
        source: target,
        expectedDigest: transaction.nextDigest,
        limits: archiveLimits
      });
    } else if (transaction.previousDigest == null ||
        !(await packageHasDigest(target, transaction.previousDigest, archiveLimits))) {
      throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 恢复不会覆盖未知目录。");
    }
  }
  if (await exists(backup)) {
    if (!transaction.previousDigest || !(await packageHasDigest(backup, transaction.previousDigest, archiveLimits))) {
      throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 备份目录摘要无效。");
    }
    if (await exists(target)) transactionInvalid("Skill 恢复目标目录仍被占用。");
    await moveRecoveryDirectory(context, {
      source: backup,
      destination: target,
      expectedDigest: transaction.previousDigest,
      limits: archiveLimits
    });
  }
  if (await exists(stage)) await bindRecoveryDirectory(context, stage, transaction.nextDigest, archiveLimits);
  await retainRecoveryJournal(context, journalPath, transaction, "rolled_back");
}

async function recoverRemovalJournal(
  context: SkillPersistenceContext,
  journalPath: string,
  transaction: SkillRemovalTransaction
) {
  const { paths, archiveLimits } = context;
  const target = safeSkillTarget(paths.skills, transaction.id);
  const backup = safeInternalPath(
    paths.skills,
    transaction.backupName,
    `.skill-tombstone-${transaction.id}-`
  );
  const index = await readSkillIndexFile(context, false);
  const record = index.skills.find((skill) => skill.id === transaction.id);
  if (transaction.state === "committed") {
    if (record) recoveryRequired("已提交的 Skill 卸载事务仍存在索引记录。");
    if (await exists(target)) recoveryRequired("已提交的 Skill 卸载事务仍存在目标目录。");
    await requirePackageDigest(
      backup,
      transaction.digest,
      archiveLimits,
      "已提交的 Skill 卸载事务缺少墓碑证据。"
    );
    await retainRecoveryJournal(context, journalPath, transaction, "committed");
    return;
  }
  if (transaction.state === "rolled_back") {
    if (!record || record.digestSha256 !== transaction.digest) {
      recoveryRequired("已回滚的 Skill 卸载事务与索引不一致。");
    }
    await requirePackageDigest(target, transaction.digest, archiveLimits, "已回滚的 Skill 卸载事务缺少目标目录。");
    if (await exists(backup)) recoveryRequired("已回滚的 Skill 卸载事务仍包含重复墓碑。");
    await retainRecoveryJournal(context, journalPath, transaction, "rolled_back");
    return;
  }
  if (record && record.digestSha256 !== transaction.digest) {
    throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 卸载事务与索引摘要不一致。");
  }
  if (!record) {
    if (await exists(target)) {
      throw storeError(409, "SKILL_TRANSACTION_INVALID", "已提交的 Skill 卸载事务仍存在目标目录。");
    }
    await requirePackageDigest(
      backup,
      transaction.digest,
      archiveLimits,
      "已提交的 Skill 卸载事务缺少墓碑证据。"
    );
    await retainRecoveryJournal(context, journalPath, transaction, "committed");
    return;
  }
  const targetExists = await exists(target);
  const backupExists = await exists(backup);
  if (targetExists && backupExists) {
    throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 卸载恢复遇到重复目录。");
  }
  if (targetExists) {
    if (!(await packageHasDigest(target, transaction.digest, archiveLimits))) {
      throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 卸载目标摘要无效。");
    }
    await retainRecoveryJournal(context, journalPath, transaction, "rolled_back");
    return;
  }
  if (!backupExists || !(await packageHasDigest(backup, transaction.digest, archiveLimits))) {
    throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 卸载备份摘要无效。");
  }
  await moveRecoveryDirectory(context, {
    source: backup,
    destination: target,
    expectedDigest: transaction.digest,
    limits: archiveLimits
  });
  await retainRecoveryJournal(context, journalPath, transaction, "rolled_back");
}

export async function retainTerminalSkillJournal(
  journalPath: string,
  transaction: SkillTransaction | SkillRemovalTransaction,
  state: "committed" | "rolled_back",
  options?: {
    renameFaultAt?: "after_rename_before_response";
    renameWorkerFailureMode?: ParentBoundWorkerFailureMode;
    renameWorkerTimeoutMs?: number;
    parentIdentity?: PinnedDirectoryIdentity;
  }
) {
  const requestedJournal = path.resolve(journalPath);
  const requestedTerminal = terminalJournalPath(requestedJournal, state);
  let initialParent = options?.parentIdentity
    ? await verifyPrivatePinnedDirectory(path.dirname(requestedJournal), options.parentIdentity)
    : await pinDirectoryIdentity(path.dirname(requestedJournal));
  journalPath = path.join(initialParent.realPath, path.basename(requestedJournal));
  const terminal = terminalJournalPath(journalPath, state);
  const desired = { ...transaction, state } as SkillTransaction | SkillRemovalTransaction;
  const initial = await journalPairState(journalPath, terminal);
  if (initial === "terminal") {
    await requireExactJournal(terminal, desired);
    return requestedTerminal;
  }
  if (initial !== "source") recoveryRequired("Skill 事务终态证据冲突或缺失。");
  await requireExactJournal(journalPath, transaction);
  if (transaction.state !== state) {
    initialParent = await atomicJson(journalPath, desired, initialParent);
  }
  const source = await requireExactJournal(journalPath, desired);
  const parent = path.dirname(journalPath);
  const parentIdentity = options?.parentIdentity
    ? await refreshPrivatePinnedDirectory(parent, initialParent)
    : await pinDirectoryIdentity(parent, parent);
  try {
    await parentBoundRename({
      source: journalPath,
      destination: terminal,
      parentIdentity,
      expectedSource: source,
      faultAt: options?.renameFaultAt,
      workerFailureMode: options?.renameWorkerFailureMode,
      workerTimeoutMs: options?.renameWorkerTimeoutMs
    });
  } catch {
    if (await journalPairState(journalPath, terminal) === "terminal") {
      await requireExactJournal(terminal, desired);
      return requestedTerminal;
    }
    recoveryRequired("Skill 事务终态移动无法安全对账。");
  }
  if (await journalPairState(journalPath, terminal) !== "terminal") {
    recoveryRequired("Skill 事务终态移动结果无效。");
  }
  await requireExactJournal(terminal, desired);
  return requestedTerminal;
}

function terminalJournalPath(journalPath: string, state: "committed" | "rolled_back") {
  const base = path.basename(journalPath);
  if (base.startsWith(".skill-remove-transaction-")) {
    return path.join(
      path.dirname(journalPath),
      base.replace(".skill-remove-transaction-", `.skill-${state}-remove-transaction-`)
    );
  }
  if (base.startsWith(".skill-transaction-")) {
    return path.join(
      path.dirname(journalPath),
      base.replace(".skill-transaction-", `.skill-${state}-transaction-`)
    );
  }
  transactionInvalid("Skill 事务日志路径无效。");
}

async function journalPairState(source: string, terminal: string) {
  const [sourceExists, terminalExists] = await Promise.all([exists(source), exists(terminal)]);
  if (sourceExists && !terminalExists) return "source" as const;
  if (!sourceExists && terminalExists) return "terminal" as const;
  return sourceExists ? "both" as const : "neither" as const;
}

async function requireExactJournal(
  journalPath: string,
  expected: SkillTransaction | SkillRemovalTransaction
) {
  let before;
  try {
    before = await fs.lstat(journalPath, { bigint: true });
  } catch {
    recoveryRequired("Skill 事务日志缺失。");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n) {
    recoveryRequired("Skill 事务日志文件属性无效。");
  }
  let parsed: SkillTransaction | SkillRemovalTransaction;
  try {
    const raw = await readJson(journalPath);
    parsed = "digest" in expected ? parseSkillRemovalTransaction(raw) : parseSkillTransaction(raw);
  } catch {
    recoveryRequired("Skill 事务日志内容无效。");
  }
  const after = await fs.lstat(journalPath, { bigint: true }).catch(() => null);
  if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== before.nlink ||
      canonicalJson(parsed) !== canonicalJson(expected)) {
    recoveryRequired("Skill 事务日志在终态转换期间发生变化。");
  }
  return after;
}

export function extensionRevision(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function packageMatches(
  directory: string,
  record: AgentSkillRecord,
  limits?: SkillArchiveLimits
) {
  try { return sameSkillEvidence(record, await inspectSkillDirectory(directory, limits)); } catch { return false; }
}

export async function packageHasDigest(directory: string, digest: string, limits?: SkillArchiveLimits) {
  try { return (await inspectSkillDirectory(directory, limits)).digestSha256 === digest; } catch { return false; }
}

async function requirePackageDigest(
  directory: string,
  digest: string,
  limits: SkillArchiveLimits | undefined,
  message: string
) {
  if (!(await exists(directory)) || !(await packageHasDigest(directory, digest, limits))) {
    recoveryRequired(message);
  }
}

function recoveryRequired(message: string): never {
  throw storeError(409, "SKILL_TRANSACTION_RECOVERY_REQUIRED", message);
}

function transactionInvalid(message: string): never {
  throw storeError(409, "SKILL_TRANSACTION_INVALID", message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareBinaryText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
