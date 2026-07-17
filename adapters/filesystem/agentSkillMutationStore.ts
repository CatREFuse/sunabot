import { randomUUID } from "node:crypto";
import path from "node:path";
import { compareBinaryText, type AgentSkillRecord } from "../../packages/contracts/extensions/agentExtensions.js";
import { atomicJson, exists, storeError, syncDirectory } from "./agentExtensionSecureFs.js";
import {
  type AgentExtensionPathGuard,
  type AgentExtensionStorePaths as StorePaths
} from "./agentExtensionPaths.js";
import { withSkillRevision } from "./agentSkillIndex.js";
import {
  packageMatches,
  readSkillIndexFile,
  recoverSkillTransactions,
  retainTerminalSkillJournal
} from "./agentSkillPersistence.js";
import {
  moveVerifiedSkillDirectory,
  quarantineVerifiedSkillDirectory
} from "./agentSkillSafeMutation.js";
import {
  safeSkillTarget,
  type SkillRemovalTransaction,
  type SkillTransaction
} from "./agentSkillTransaction.js";
import type { SkillArchiveLimits } from "./skillArchive.js";

interface AgentSkillMutationStoreOptions {
  pathGuard: AgentExtensionPathGuard;
  archiveLimits?: SkillArchiveLimits;
  ensureLayout: (agentId: string) => Promise<void>;
  withTransaction: <T>(agentId: string, operation: () => Promise<T>) => Promise<T>;
  serialized: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  withFileLock: <T>(paths: StorePaths, lockPath: string, operation: () => Promise<T>) => Promise<T>;
  persistence: (paths: StorePaths) => Parameters<typeof readSkillIndexFile>[0];
  fault: (step: string) => Promise<void>;
}

export class AgentSkillMutationStore {
  constructor(private readonly options: AgentSkillMutationStoreOptions) {}

  async setEnabled(input: { agentId: string; skillId: string; enabled: boolean }) {
    await this.options.ensureLayout(input.agentId);
    return this.options.withTransaction(input.agentId, () =>
      this.options.serialized(`skills:${input.agentId}`, async () => {
        const paths = await this.options.pathGuard.paths(input.agentId);
        await this.options.pathGuard.guard(paths, "set-skill-enabled");
        return this.options.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
          await recoverSkillTransactions(this.options.persistence(paths));
          const index = await readSkillIndexFile(this.options.persistence(paths), true);
          const record = index.skills.find((skill) => skill.id === input.skillId);
          if (!record) {
            if (await exists(safeSkillTarget(paths.skills, input.skillId))) {
              throw storeError(409, "SKILL_UNTRACKED_PACKAGE", "Skill 目录未被可信索引跟踪。");
            }
            throw storeError(404, "SKILL_NOT_FOUND", "Skill 不存在。");
          }
          if (input.enabled && !skillDoublyApproved(record)) {
            throw storeError(409, "SKILL_REVIEW_REQUIRED", "Skill 启用前需要完成当前内容的安全审查。");
          }
          if (record.enabled === input.enabled) return record;
          const updated = { ...record, enabled: input.enabled };
          await this.options.pathGuard.guard(paths, "set-skill-enabled-commit");
          await atomicJson(paths.skillIndex, withSkillRevision(index.skills.map((skill) =>
            skill.id === input.skillId ? updated : skill
          )));
          return updated;
        });
      })
    );
  }

  async uninstall(input: { agentId: string; skillId: string; expectedIndexRevision?: string }) {
    await this.options.ensureLayout(input.agentId);
    return this.options.withTransaction(input.agentId, () =>
      this.options.serialized(`skills:${input.agentId}`, async () => {
        const paths = await this.options.pathGuard.paths(input.agentId);
        await this.options.pathGuard.guard(paths, "uninstall-skill");
        return this.options.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
          await recoverSkillTransactions(this.options.persistence(paths));
          const index = await readSkillIndexFile(this.options.persistence(paths), true);
          if (input.expectedIndexRevision && index.revision !== input.expectedIndexRevision) {
            throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制目标 Skill 索引已变化。");
          }
          const target = safeSkillTarget(paths.skills, input.skillId);
          const record = index.skills.find((skill) => skill.id === input.skillId);
          if (!record) {
            if (await exists(target)) throw storeError(409, "SKILL_UNTRACKED_PACKAGE", "Skill 目录未被可信索引跟踪。");
            throw storeError(404, "SKILL_NOT_FOUND", "Skill 不存在。");
          }
          const transactionId = randomUUID();
          const backup = path.join(paths.skills, `.skill-tombstone-${record.id}-${transactionId}`);
          const journal = path.join(paths.skills, `.skill-remove-transaction-${transactionId}.json`);
          const transaction: SkillRemovalTransaction = {
            schemaVersion: 1,
            state: "prepared",
            id: record.id,
            digest: record.digestSha256,
            backupName: path.basename(backup)
          };
          await this.options.pathGuard.guard(paths, "uninstall-skill-commit");
          await atomicJson(journal, transaction);
          try {
            await moveVerifiedSkillDirectory({
              source: target,
              destination: backup,
              expectedDigest: record.digestSha256,
              limits: this.options.archiveLimits,
              hooks: this.renameHooks("skill-remove")
            });
            await syncDirectory(paths.skills);
            await this.options.fault("after-skill-remove-directory");
            await atomicJson(paths.skillIndex, withSkillRevision(index.skills.filter((skill) => skill.id !== record.id)));
            await this.options.fault("after-skill-remove-index");
            await retainTerminalSkillJournal(journal, transaction, "committed");
            await syncDirectory(paths.skills);
            return record;
          } catch (error) {
            const current = await readSkillIndexFile(this.options.persistence(paths), false);
            if (!current.skills.some((skill) => skill.id === record.id)) {
              await retainTerminalSkillJournal(journal, transaction, "committed");
              await syncDirectory(paths.skills);
              return record;
            }
            const [targetExists, backupExists] = await Promise.all([exists(target), exists(backup)]);
            if (targetExists && backupExists) {
              throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 卸载回滚遇到重复目录。");
            }
            if (!targetExists && backupExists) {
              await moveVerifiedSkillDirectory({
                source: backup,
                destination: target,
                expectedDigest: record.digestSha256,
                limits: this.options.archiveLimits,
                hooks: this.renameHooks("skill-remove-rollback")
              });
            } else if (!targetExists) {
              throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 卸载回滚缺少可信目录。");
            }
            await syncDirectory(paths.skills);
            await retainTerminalSkillJournal(journal, transaction, "rolled_back");
            await syncDirectory(paths.skills);
            throw error;
          }
        });
      })
    );
  }

  async publishLocked(
    paths: StorePaths,
    record: AgentSkillRecord,
    stage: string,
    replace: boolean,
    expectedIndexRevision?: string
  ) {
    await recoverSkillTransactions(this.options.persistence(paths));
    const index = await readSkillIndexFile(this.options.persistence(paths), true);
    if (expectedIndexRevision && index.revision !== expectedIndexRevision) {
      throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制目标 Skill 索引已变化。");
    }
    const previous = index.skills.find((skill) => skill.id === record.id);
    if (previous && !replace) throw storeError(409, "SKILL_CONFLICT", "Skill 已存在，如需替换请显式确认。");
    const target = safeSkillTarget(paths.skills, record.id);
    const transactionId = randomUUID();
    const backup = path.join(paths.skills, `.skill-quarantine-${record.id}-${transactionId}`);
    const journal = path.join(paths.skills, `.skill-transaction-${transactionId}.json`);
    const transaction: SkillTransaction = {
      schemaVersion: 1,
      state: "prepared",
      id: record.id,
      previousDigest: previous?.digestSha256 ?? null,
      nextDigest: record.digestSha256,
      stageName: path.basename(stage),
      backupName: path.basename(backup)
    };
    await this.options.pathGuard.guard(paths, "publish-skill-commit");
    await atomicJson(journal, transaction);
    try {
      if (previous) {
        await moveVerifiedSkillDirectory({
          source: target,
          destination: backup,
          expectedDigest: previous.digestSha256,
          limits: this.options.archiveLimits,
          hooks: this.renameHooks("skill-backup")
        });
      }
      await moveVerifiedSkillDirectory({
        source: stage,
        destination: target,
        expectedDigest: record.digestSha256,
        limits: this.options.archiveLimits,
        hooks: this.renameHooks("skill-target")
      });
      await syncDirectory(paths.skills);
      await this.options.fault("after-skill-directory-publish");
      const skills = [...index.skills.filter((skill) => skill.id !== record.id), record]
        .sort((left, right) => compareBinaryText(left.id, right.id));
      await atomicJson(paths.skillIndex, withSkillRevision(skills));
      await this.options.fault("after-skill-index-publish");
      await retainTerminalSkillJournal(journal, transaction, "committed");
      await syncDirectory(paths.skills);
      return record;
    } catch (error) {
      const current = await readSkillIndexFile(this.options.persistence(paths), false);
      if (current.skills.some((skill) => skill.id === record.id && skill.digestSha256 === record.digestSha256)) {
        await retainTerminalSkillJournal(journal, transaction, "committed");
        await syncDirectory(paths.skills);
        return record;
      }
      const targetExists = await exists(target);
      const targetHasNext = targetExists && await packageMatches(target, record, this.options.archiveLimits);
      const targetHasPrevious = Boolean(previous) && targetExists &&
        await packageMatches(target, previous!, this.options.archiveLimits);
      if (targetHasNext) {
        await quarantineVerifiedSkillDirectory({
          source: target,
          expectedDigest: record.digestSha256,
          limits: this.options.archiveLimits,
          hooks: this.renameHooks("skill-target-quarantine")
        });
      } else if (targetExists && !targetHasPrevious) {
        throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 发布回滚遇到未知目标目录。");
      }
      if (previous) {
        const backupExists = await exists(backup);
        if (backupExists) {
          if (await exists(target)) {
            throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 发布回滚遇到重复目录。");
          }
          await moveVerifiedSkillDirectory({
            source: backup,
            destination: target,
            expectedDigest: previous.digestSha256,
            limits: this.options.archiveLimits,
            hooks: this.renameHooks("skill-backup-restore")
          });
        } else if (!(await packageMatches(target, previous, this.options.archiveLimits))) {
          throw storeError(409, "SKILL_TRANSACTION_INVALID", "Skill 发布回滚缺少可信旧版本。");
        }
      }
      await syncDirectory(paths.skills);
      await retainTerminalSkillJournal(journal, transaction, "rolled_back");
      await syncDirectory(paths.skills);
      throw error;
    }
  }

  private renameHooks(name: string) {
    return {
      beforeRename: () => this.options.fault(`before-${name}-rename`),
      afterRename: () => this.options.fault(`after-${name}-rename`)
    };
  }
}

function skillDoublyApproved(record: AgentSkillRecord) {
  return record.approval?.status === "approved" &&
    record.approval.digestSha256 === record.digestSha256 &&
    record.riskEvidence.reviewStatus === "approved" &&
    record.riskEvidence.reviewedDigestSha256 === record.digestSha256;
}
