import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type AgentExtensionCopyApplyResult,
  type AgentExtensionCopyConflictStrategy,
  type AgentMcpServerDescriptor,
  type AgentSkillRecord,
  type AgentSkillSource
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  skillRecordFromEvidence,
  type AgentExtensionRepository,
  type AgentMcpCredentialStatusResolver,
  type SkillReviewPreparation
} from "../../services/extensions/public.js";
import {
  acquireFileLock,
  atomicJson,
  exists,
  mkdirChain,
  readJson,
  storeError,
  writeJsonIfMissing,
  type AgentExtensionBeforeFileOpen
} from "./agentExtensionSecureFs.js";
import { AgentExtensionCopyLifecycle } from "./agentExtensionCopyLifecycle.js";
import { AgentExtensionTransactionCoordinator } from "./agentExtensionTransactionCoordinator.js";
import {
  AgentExtensionPathGuard,
  type AgentExtensionStorePaths as StorePaths
} from "./agentExtensionPaths.js";
import {
  safeSkillTarget,
} from "./agentSkillTransaction.js";
import {
  readSkillIndexFile,
  recoverSkillTransactions
} from "./agentSkillPersistence.js";
import { validateSkillIndex, withSkillRevision } from "./agentSkillIndex.js";
import { AgentSkillMutationStore } from "./agentSkillMutationStore.js";
import {
  moveVerifiedSkillDirectory,
  quarantineVerifiedSkillDirectory
} from "./agentSkillSafeMutation.js";
import {
  prepareSkillReviewPackage,
  verifySkillReviewPackage
} from "./agentSkillReview.js";
import { extractSkillArchive, type SkillArchiveExtractionHooks, type SkillArchiveLimits } from "./skillArchive.js";
import { AgentMcpServerStore, validateMcpIndex, withMcpRevision } from "./agentMcpServerStore.js";

export interface AgentExtensionStoreOptions {
  workspaceRoot: string;
  archiveLimits?: SkillArchiveLimits;
  archiveHooks?: SkillArchiveExtractionHooks;
  now?: () => Date;
  faultInjector?: (step: string) => void | Promise<void>;
  beforeFileOpen?: AgentExtensionBeforeFileOpen;
  beforeWorkspaceRealpath?: () => void | Promise<void>;
  beforePathOperation?: (operation: string) => void | Promise<void>;
  beforeSkillReviewFileOpen?: (absolute: string, relative: string) => void | Promise<void>;
}

export class AgentExtensionStore implements AgentExtensionRepository {
  private readonly now: () => Date;
  private readonly runLayoutCheck = createLayoutCheckCoordinator();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pathGuard: AgentExtensionPathGuard;
  private readonly copyLifecycle: AgentExtensionCopyLifecycle;
  private readonly mcpStore: AgentMcpServerStore;
  private readonly skillMutations: AgentSkillMutationStore;
  private readonly extensionTransactions = new AgentExtensionTransactionCoordinator();

  constructor(private readonly options: AgentExtensionStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.pathGuard = new AgentExtensionPathGuard(options.workspaceRoot, options);
    this.mcpStore = new AgentMcpServerStore({
      pathGuard: this.pathGuard,
      ensureLayout: (agentId) => this.ensureLayout(agentId),
      beforeFileOpen: options.beforeFileOpen
    });
    this.copyLifecycle = new AgentExtensionCopyLifecycle({
      repository: this,
      pathGuard: this.pathGuard,
      archiveLimits: options.archiveLimits,
      fault: (step) => this.fault(step)
    });
    this.skillMutations = new AgentSkillMutationStore({
      pathGuard: this.pathGuard,
      archiveLimits: options.archiveLimits,
      ensureLayout: (agentId) => this.ensureLayout(agentId),
      withTransaction: (agentId, operation) => this.withExtensionTransaction(agentId, operation),
      serialized: (key, operation) => this.serialized(key, operation),
      withFileLock: (paths, lockPath, operation) => this.withFileLock(paths, lockPath, operation),
      persistence: (paths) => this.skillPersistence(paths),
      fault: (step) => this.fault(step)
    });
  }

  async ensureLayout(agentId: string) {
    return this.runLayoutCheck(agentId, this.extensionTransactions.owns(agentId), () => this.ensureLayoutOnce(agentId));
  }

  private async ensureLayoutOnce(agentId: string) {
    const paths = await this.pathGuard.paths(agentId);
    await this.pathGuard.guard(paths, "ensure-layout-probe");
    const layoutReady = this.pathGuard.isPinned(paths, paths.skills) &&
      this.pathGuard.isPinned(paths, paths.mcp) &&
      (await Promise.all([
        exists(paths.skillIndex),
        exists(paths.mcpIndex)
      ])).every(Boolean);
    if (layoutReady) {
      await this.pathGuard.guard(paths, "ensure-layout-existing");
      await Promise.all([
        readSkillIndexFile(this.skillPersistence(paths), false),
        readJson(paths.mcpIndex, this.options.beforeFileOpen).then(validateMcpIndex)
      ]);
      await this.pathGuard.guard(paths, "ensure-layout-existing-validated");
      await this.recoverCopyTransactions(agentId);
      return;
    }
    await this.pathGuard.guardBase(paths, "ensure-layout-lock");
    const lockPath = path.join(paths.agent, ".extensions-layout.lock");
    const handle = await acquireFileLock(lockPath);
    try {
      await this.pathGuard.refreshBase(paths, {
        allowAgentChange: true
      });
      await this.pathGuard.refresh(paths, {
        allowCreated: this.pathGuard.controlledPaths(paths),
        allowChanged: [paths.skills, paths.mcp]
      });
      const extensions = path.dirname(paths.skills);
      const extensionsExisted = this.pathGuard.isPinned(paths, extensions);
      const skillsExisted = this.pathGuard.isPinned(paths, paths.skills);
      await this.pathGuard.guard(paths, "ensure-layout");
      await mkdirChain(paths.workspace, path.relative(paths.workspace, paths.skills));
      await this.pathGuard.refresh(paths, {
        allowCreated: [extensions, paths.skills],
        allowChanged: extensionsExisted && !skillsExisted ? [extensions] : [],
        allowAgentChange: !extensionsExisted
      });
      const mcpExisted = this.pathGuard.isPinned(paths, paths.mcp);
      await this.pathGuard.guard(paths, "ensure-layout");
      await mkdirChain(paths.workspace, path.relative(paths.workspace, paths.mcp));
      await this.pathGuard.refresh(paths, {
        allowCreated: [paths.mcp],
        allowChanged: mcpExisted ? [] : [extensions]
      });
      await this.pathGuard.guard(paths, "ensure-layout-config");
      await writeJsonIfMissing(
        paths.skillIndex,
        withSkillRevision([]),
        validateSkillIndex,
        this.options.beforeFileOpen
      );
      await writeJsonIfMissing(
        paths.mcpIndex,
        withMcpRevision([]),
        validateMcpIndex,
        this.options.beforeFileOpen
      );
    } finally {
      await handle.close();
      await this.pathGuard.refresh(paths, {
        allowChanged: [paths.skills, paths.mcp],
        allowAgentChange: true
      });
      await this.pathGuard.guard(paths, "release-layout-lock");
    }
    await this.recoverCopyTransactions(agentId);
  }

  async readSkillIndex(agentId: string) {
    return this.serialized(`skills:${agentId}`, async () => {
      const paths = await this.pathGuard.paths(agentId);
      await this.pathGuard.guard(paths, "read-skill-index");
      if (!(await exists(paths.skills))) return withSkillRevision([]);
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        return readSkillIndexFile(this.skillPersistence(paths), true);
      });
    });
  }

  async readMcpServerIndex(agentId: string) {
    return this.mcpStore.readServerIndex(agentId);
  }

  async installSkill(input: {
    agentId: string;
    archive: Buffer;
    replace: boolean;
    source?: AgentSkillSource;
    expectedIndexRevision?: string;
  }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "install-skill-stage");
      return this.serialized(`skills:${input.agentId}`, async () => {
        return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        const extracted = await extractSkillArchive({
          archive: input.archive,
          stagingRoot: paths.skills,
          stagingRootIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
          limits: this.options.archiveLimits,
          hooks: this.options.archiveHooks
        });
        await this.pathGuard.refresh(paths, { allowChanged: [paths.skills] });
        const stage = path.join(paths.skills, `.skill-publish-${randomUUID()}`);
        try {
          await this.pathGuard.guard(paths, "install-skill-publish");
          await moveVerifiedSkillDirectory({
            source: extracted.packageRoot,
            destination: stage,
            expectedDigest: extracted.evidence.digestSha256,
            limits: this.options.archiveLimits,
            hooks: {
              beforeRename: () => this.fault("before-skill-stage-publish-rename"),
              afterRename: () => this.fault("after-skill-stage-publish-rename")
            }
          });
          await this.pathGuard.refresh(paths, { allowChanged: [paths.skills] });
          const record = skillRecordFromEvidence(
            extracted.evidence,
            input.source ?? { kind: "upload" },
            this.now().toISOString(),
            false
          );
          return await this.skillMutations.publishLocked(
            paths,
            record,
            stage,
            input.replace,
            input.expectedIndexRevision
          );
        } catch (error) {
          await quarantineVerifiedSkillDirectory({
            source: stage,
            expectedDigest: extracted.evidence.digestSha256,
            limits: this.options.archiveLimits,
            hooks: {
              beforeRename: () => this.fault("before-skill-stage-quarantine-rename"),
              afterRename: () => this.fault("after-skill-stage-quarantine-rename")
            }
          });
          throw error;
        }
        });
      });
    });
  }

  async previewCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds: string[];
    credentialStatus: AgentMcpCredentialStatusResolver;
  }) {
    return this.copyLifecycle.preview(input);
  }

  async prepareSkillReview(input: { agentId: string; skillId: string }): Promise<SkillReviewPreparation> {
    await this.ensureLayout(input.agentId);
    return this.serialized(`skills:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "prepare-skill-review");
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        const index = await readSkillIndexFile(this.skillPersistence(paths), true);
        const record = index.skills.find((skill) => skill.id === input.skillId);
        if (!record) throw storeError(404, "SKILL_NOT_FOUND", "Skill 不存在。");
        return prepareSkillReviewPackage({
          agentId: input.agentId,
          record,
          indexRevision: index.revision,
          directory: safeSkillTarget(paths.skills, input.skillId),
          skillsIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
          archiveLimits: this.options.archiveLimits,
          beforeFileOpen: this.options.beforeSkillReviewFileOpen
        });
      });
    });
  }

  async commitSkillReview(input: {
    agentId: string;
    skillId: string;
    expectedIndexRevision: string;
    expectedDigestSha256: string;
    expectedFiles: SkillReviewPreparation["files"];
    auditDigestSha256: string;
  }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.serialized(`skills:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "commit-skill-review");
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        const index = await readSkillIndexFile(this.skillPersistence(paths), true);
        const record = index.skills.find((skill) => skill.id === input.skillId);
        if (!record) throw storeError(404, "SKILL_NOT_FOUND", "Skill 不存在。");
        if (index.revision !== input.expectedIndexRevision ||
            record.digestSha256 !== input.expectedDigestSha256 ||
            input.auditDigestSha256 !== input.expectedDigestSha256) {
          throw storeError(409, "SKILL_REVIEW_STALE", "Skill 在安全审查期间发生变化，请重新审查。");
        }
        const evidence = await verifySkillReviewPackage({
          record,
          directory: safeSkillTarget(paths.skills, input.skillId),
          skillsIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
          expectedFiles: input.expectedFiles,
          archiveLimits: this.options.archiveLimits
        });
        const approvedAt = this.now().toISOString();
        const updated: AgentSkillRecord = {
          ...record,
          enabled: false,
          riskEvidence: {
            ...evidence.riskEvidence,
            reviewStatus: "approved",
            reviewedDigestSha256: record.digestSha256
          },
          approval: {
            status: "approved",
            digestSha256: record.digestSha256,
            approvedAt
          }
        };
        await this.pathGuard.guard(paths, "commit-skill-review-index");
        await atomicJson(paths.skillIndex, withSkillRevision(index.skills.map((skill) =>
          skill.id === input.skillId ? updated : skill
        )));
        return updated;
      });
    }));
  }

  async applyCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds: string[];
    previewRevision: string;
    conflictStrategy: AgentExtensionCopyConflictStrategy;
    renameTo?: string;
    credentialStatus: AgentMcpCredentialStatusResolver;
  }): Promise<AgentExtensionCopyApplyResult> {
    await this.ensureLayout(input.targetAgentId);
    return this.withExtensionTransaction(input.targetAgentId, () => this.copyLifecycle.apply(input));
  }

  async setSkillEnabled(input: { agentId: string; skillId: string; enabled: boolean }) {
    return this.skillMutations.setEnabled(input);
  }

  async restoreReviewedSkill(input: { agentId: string; previous: AgentSkillRecord }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.serialized(`skills:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "restore-reviewed-skill");
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        const index = await readSkillIndexFile(this.skillPersistence(paths), true);
        const record = index.skills.find((skill) => skill.id === input.previous.id);
        if (!record || !skillDoublyApproved(input.previous) ||
            record.digestSha256 !== input.previous.digestSha256 ||
            !sameSkillReviewIdentity(record, input.previous)) {
          throw storeError(409, "SKILL_REVIEW_RESTORE_INVALID", "Skill 回滚审批证据无效。");
        }
        const preparation = await prepareSkillReviewPackage({
          agentId: input.agentId,
          record,
          indexRevision: index.revision,
          directory: safeSkillTarget(paths.skills, record.id),
          skillsIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
          archiveLimits: this.options.archiveLimits
        });
        try {
          await verifySkillReviewPackage({
            record,
            directory: safeSkillTarget(paths.skills, record.id),
            skillsIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
            expectedFiles: preparation.files,
            archiveLimits: this.options.archiveLimits
          });
        } finally {
          clearSkillReviewBuffers(preparation);
        }
        const updated: AgentSkillRecord = {
          ...record,
          enabled: input.previous.enabled,
          riskEvidence: structuredClone(input.previous.riskEvidence),
          approval: structuredClone(input.previous.approval!)
        };
        await this.pathGuard.guard(paths, "restore-reviewed-skill-index");
        await atomicJson(paths.skillIndex, withSkillRevision(index.skills.map((skill) =>
          skill.id === record.id ? updated : skill
        )));
        return updated;
      });
    }));
  }

  async restoreSkillRecord(input: { agentId: string; previous: AgentSkillRecord }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.serialized(`skills:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "restore-copy-skill-record");
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        const index = await readSkillIndexFile(this.skillPersistence(paths), true);
        const record = index.skills.find((skill) => skill.id === input.previous.id);
        const approvalBearing = input.previous.enabled ||
          input.previous.approval?.status === "approved" ||
          input.previous.riskEvidence.reviewStatus === "approved";
        if (!record || record.digestSha256 !== input.previous.digestSha256 ||
            !sameSkillReviewIdentity(record, input.previous) ||
            (approvalBearing && !skillDoublyApproved(input.previous))) {
          throw storeError(409, "SKILL_REVIEW_RESTORE_INVALID", "Skill 回滚记录无效。");
        }
        const preparation = await prepareSkillReviewPackage({
          agentId: input.agentId,
          record,
          indexRevision: index.revision,
          directory: safeSkillTarget(paths.skills, record.id),
          skillsIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
          archiveLimits: this.options.archiveLimits
        });
        try {
          await verifySkillReviewPackage({
            record,
            directory: safeSkillTarget(paths.skills, record.id),
            skillsIdentity: this.pathGuard.directoryIdentity(paths, paths.skills),
            expectedFiles: preparation.files,
            archiveLimits: this.options.archiveLimits
          });
        } finally {
          clearSkillReviewBuffers(preparation);
        }
        const updated = structuredClone(input.previous);
        await this.pathGuard.guard(paths, "restore-copy-skill-record-index");
        await atomicJson(paths.skillIndex, withSkillRevision(index.skills.map((skill) =>
          skill.id === record.id ? updated : skill
        )));
        return updated;
      });
    }));
  }

  async uninstallSkill(input: { agentId: string; skillId: string; expectedIndexRevision?: string }) {
    return this.skillMutations.uninstall(input);
  }

  async putMcpServer(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
    replace: boolean;
    expectedIndexRevision?: string;
  }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.mcpStore.putServer(input));
  }

  async setMcpServerEnabled(input: {
    agentId: string;
    serverId: string;
    enabled: boolean;
    credentialStatus: AgentMcpCredentialStatusResolver;
  }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.mcpStore.setServerEnabled(input));
  }

  async removeMcpServer(input: { agentId: string; serverId: string; expectedIndexRevision?: string }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.mcpStore.removeServer(input));
  }

  async bindMcpOAuthCredential(input: {
    agentId: string;
    serverId: string;
    expectedRevision: string;
    expectedUrl: string;
    credentialRef: string;
  }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.mcpStore.bindOAuthCredential(input));
  }

  async disableMcpOAuthCredential(input: {
    agentId: string;
    serverId: string;
    expectedRevision: string;
    expectedUrl: string;
    credentialRef: string;
  }) {
    await this.ensureLayout(input.agentId);
    return this.withExtensionTransaction(input.agentId, () => this.mcpStore.disableOAuthCredential(input));
  }

  private async withFileLock<T>(
    paths: StorePaths,
    lockPath: string,
    operation: () => Promise<T>,
    allowChanged = [path.dirname(lockPath)]
  ) {
    await this.pathGuard.guard(paths, "acquire-extension-lock");
    const lockParent = path.dirname(lockPath);
    const handle = await acquireFileLock(lockPath);
    await this.pathGuard.refresh(paths, { allowChanged: [lockParent] });
    try {
      return await operation();
    } finally {
      await handle.close();
      await this.pathGuard.refresh(paths, { allowChanged });
      await this.pathGuard.guard(paths, "release-extension-lock");
    }
  }

  private serialized<T>(key: string, operation: () => Promise<T>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }

  private async fault(step: string) { await this.options.faultInjector?.(step); }

  private async recoverCopyTransactions(agentId: string) {
    if (this.extensionTransactions.owns(agentId)) return;
    await this.withExtensionTransaction(agentId, () => this.copyLifecycle.recover(agentId));
  }

  private async withExtensionTransaction<T>(agentId: string, operation: () => Promise<T>) {
    return this.extensionTransactions.run(agentId, operation, async (scopedOperation) => {
      const paths = await this.pathGuard.paths(agentId);
      return await this.serialized(`copy:${agentId}`, () => this.withFileLock(
        paths,
        path.join(paths.skills, ".copy.lock"),
        scopedOperation,
        [paths.skills, paths.mcp]
      ));
    });
  }

  private skillPersistence(paths: StorePaths) {
    return {
      paths,
      pathGuard: this.pathGuard,
      beforeFileOpen: this.options.beforeFileOpen,
      archiveLimits: this.options.archiveLimits,
      beforeRecoveryMutation: () => this.fault("before-skill-recovery-mutation")
    };
  }
}

function createLayoutCheckCoordinator() {
  const checks = new Map<string, Promise<void>>();
  return (key: string, bypass: boolean, operation: () => Promise<void>) => {
    if (bypass) return operation();
    const existing = checks.get(key);
    if (existing) return existing;
    const current = operation().finally(() => {
      if (checks.get(key) === current) checks.delete(key);
    });
    checks.set(key, current);
    return current;
  };
}

function skillDoublyApproved(record: AgentSkillRecord) {
  return record.approval?.status === "approved" &&
    record.approval.digestSha256 === record.digestSha256 &&
    record.riskEvidence.reviewStatus === "approved" &&
    record.riskEvidence.reviewedDigestSha256 === record.digestSha256;
}

function sameSkillReviewIdentity(current: AgentSkillRecord, previous: AgentSkillRecord) {
  return current.id === previous.id && current.name === previous.name &&
    current.description === previous.description && current.license === previous.license &&
    current.compatibility === previous.compatibility && current.digestSha256 === previous.digestSha256 &&
    current.fileCount === previous.fileCount && current.unpackedBytes === previous.unpackedBytes &&
    JSON.stringify(current.metadata) === JSON.stringify(previous.metadata) &&
    JSON.stringify(current.allowedTools) === JSON.stringify(previous.allowedTools) &&
    JSON.stringify({
      ...current.riskEvidence,
      reviewStatus: undefined,
      reviewedDigestSha256: undefined
    }) === JSON.stringify({
      ...previous.riskEvidence,
      reviewStatus: undefined,
      reviewedDigestSha256: undefined
    });
}

function clearSkillReviewBuffers(preparation: SkillReviewPreparation) {
  const buffers = new Set([
    ...preparation.scripts.map((script) => script.content),
    ...preparation.texts.map((text) => text.content)
  ]);
  for (const content of buffers) content.fill(0);
}
