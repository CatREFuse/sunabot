import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  AGENT_EXTENSION_SCHEMA_VERSION,
  compareBinaryText,
  emptyAgentMcpServerIndex,
  emptyAgentSkillIndex,
  parseAgentMcpServerIndex,
  parseAgentMcpServerDescriptor,
  parseAgentSkillIndex,
  type AgentMcpServerDescriptor,
  type AgentMcpServerIndex,
  type AgentSkillIndex,
  type AgentSkillRecord
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  skillRecordFromEvidence,
  type AgentExtensionRepository,
  type AgentMcpCredentialStatusResolver
} from "../../services/extensions/public.js";
import {
  acquireFileLock,
  atomicJson,
  exists,
  mkdirChain,
  readJson,
  storeError,
  syncDirectory,
  writeJsonIfMissing,
  type AgentExtensionBeforeFileOpen
} from "./agentExtensionSecureFs.js";
import { buildAgentExtensionCopyPreview } from "./agentExtensionPreview.js";
import {
  AgentExtensionPathGuard,
  type AgentExtensionStorePaths as StorePaths
} from "./agentExtensionPaths.js";
import {
  safeSkillTarget,
  type SkillRemovalTransaction,
  type SkillTransaction
} from "./agentSkillTransaction.js";
import {
  extensionRevision,
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
  extractSkillArchive,
  inspectSkillDirectory,
  type SkillArchiveExtractionHooks,
  type SkillArchiveLimits
} from "./skillArchive.js";

export interface AgentExtensionStoreOptions {
  workspaceRoot: string;
  archiveLimits?: SkillArchiveLimits;
  archiveHooks?: SkillArchiveExtractionHooks;
  now?: () => Date;
  faultInjector?: (step: string) => void | Promise<void>;
  beforeFileOpen?: AgentExtensionBeforeFileOpen;
  beforeWorkspaceRealpath?: () => void | Promise<void>;
  beforePathOperation?: (operation: string) => void | Promise<void>;
}

export class AgentExtensionStore implements AgentExtensionRepository {
  private readonly now: () => Date;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pathGuard: AgentExtensionPathGuard;

  constructor(private readonly options: AgentExtensionStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.pathGuard = new AgentExtensionPathGuard(options.workspaceRoot, options);
  }

  async ensureLayout(agentId: string) {
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
  }

  async readSkillIndex(agentId: string) {
    return this.serialized(`skills:${agentId}`, async () => {
      const paths = await this.pathGuard.paths(agentId);
      await this.pathGuard.guard(paths, "read-skill-index");
      if (!(await exists(paths.skills))) return emptyAgentSkillIndex();
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        return readSkillIndexFile(this.skillPersistence(paths), true);
      });
    });
  }

  async readMcpServerIndex(agentId: string) {
    const paths = await this.pathGuard.paths(agentId);
    await this.pathGuard.guard(paths, "read-mcp-index");
    if (!(await exists(paths.mcpIndex))) return emptyAgentMcpServerIndex();
    const index = parseAgentMcpServerIndex(await readJson(paths.mcpIndex, this.options.beforeFileOpen));
    if (index.revision !== extensionRevision([...index.servers].sort((left, right) => compareBinaryText(left.id, right.id)))) {
      throw storeError(409, "MCP_INDEX_REVISION_MISMATCH", "MCP 服务索引 revision 无效。");
    }
    return index;
  }

  async installSkill(input: { agentId: string; archive: Buffer; replace: boolean }) {
    await this.ensureLayout(input.agentId);
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
            { kind: "upload" },
            this.now().toISOString()
          );
          return await this.publishSkillLocked(paths, record, stage, input.replace);
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
  }

  async previewCopy(input: {
    sourceAgentId: string;
    targetAgentId: string;
    skillId: string;
    mcpServerIds: string[];
    credentialStatus: AgentMcpCredentialStatusResolver;
  }) {
    const [sourceSkills, targetSkills, sourceMcp, targetMcp] = await Promise.all([
      this.readSkillIndex(input.sourceAgentId),
      this.readSkillIndex(input.targetAgentId),
      this.readMcpServerIndex(input.sourceAgentId),
      this.readMcpServerIndex(input.targetAgentId)
    ]);
    const sourcePaths = await this.pathGuard.paths(input.sourceAgentId);
    await this.pathGuard.guard(sourcePaths, "preview-skill-copy");
    const evidence = await inspectSkillDirectory(
      safeSkillTarget(sourcePaths.skills, input.skillId),
      this.options.archiveLimits
    );
    return buildAgentExtensionCopyPreview({
      ...input,
      sourceSkills,
      targetSkills,
      sourceMcp,
      targetMcp,
      evidence,
      credentialStatus: input.credentialStatus
    });
  }

  async setSkillEnabled(input: { agentId: string; skillId: string; enabled: boolean }) {
    await this.ensureLayout(input.agentId);
    return this.serialized(`skills:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "set-skill-enabled");
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        const index = await readSkillIndexFile(this.skillPersistence(paths), true);
        const record = index.skills.find((skill) => skill.id === input.skillId);
        if (!record) {
          if (await exists(safeSkillTarget(paths.skills, input.skillId))) {
            throw storeError(409, "SKILL_UNTRACKED_PACKAGE", "Skill 目录未被可信索引跟踪。");
          }
          throw storeError(404, "SKILL_NOT_FOUND", "Skill 不存在。");
        }
        if (record.enabled === input.enabled) return record;
        const updated = { ...record, enabled: input.enabled };
        await this.pathGuard.guard(paths, "set-skill-enabled-commit");
        await atomicJson(paths.skillIndex, withSkillRevision(index.skills.map((skill) =>
          skill.id === input.skillId ? updated : skill
        )));
        return updated;
      });
    });
  }

  async uninstallSkill(input: { agentId: string; skillId: string }) {
    await this.ensureLayout(input.agentId);
    return this.serialized(`skills:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "uninstall-skill");
      return this.withFileLock(paths, path.join(paths.skills, ".index.lock"), async () => {
        await recoverSkillTransactions(this.skillPersistence(paths));
        const index = await readSkillIndexFile(this.skillPersistence(paths), true);
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
        await this.pathGuard.guard(paths, "uninstall-skill-commit");
        await atomicJson(journal, transaction);
        try {
          await moveVerifiedSkillDirectory({
            source: target,
            destination: backup,
            expectedDigest: record.digestSha256,
            limits: this.options.archiveLimits,
            hooks: {
              beforeRename: () => this.fault("before-skill-remove-rename"),
              afterRename: () => this.fault("after-skill-remove-rename")
            }
          });
          await syncDirectory(paths.skills);
          await this.fault("after-skill-remove-directory");
          await atomicJson(paths.skillIndex, withSkillRevision(index.skills.filter((skill) => skill.id !== record.id)));
          await this.fault("after-skill-remove-index");
          await retainTerminalSkillJournal(journal, transaction, "committed");
          await syncDirectory(paths.skills);
          return record;
        } catch (error) {
          const current = await readSkillIndexFile(this.skillPersistence(paths), false);
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
              hooks: {
                beforeRename: () => this.fault("before-skill-remove-rollback-rename"),
                afterRename: () => this.fault("after-skill-remove-rollback-rename")
              }
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
    });
  }

  async putMcpServer(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
    replace: boolean;
  }) {
    await this.ensureLayout(input.agentId);
    return this.serialized(`mcp:${input.agentId}`, async () => {
      const server = parseAgentMcpServerDescriptor(input.server);
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "put-mcp-server");
      return this.withFileLock(paths, path.join(paths.mcp, ".index.lock"), async () => {
        const index = await this.readMcpServerIndex(input.agentId);
        const existing = index.servers.find((candidate) => candidate.id === server.id);
        if (existing && !input.replace) throw storeError(409, "MCP_SERVER_CONFLICT", "MCP 服务已存在。");
        const servers = [...index.servers.filter((candidate) => candidate.id !== server.id), server]
          .sort((left, right) => compareBinaryText(left.id, right.id));
        await this.pathGuard.guard(paths, "put-mcp-server-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(servers));
        return server;
      });
    });
  }

  async setMcpServerEnabled(input: { agentId: string; serverId: string; enabled: boolean }) {
    await this.ensureLayout(input.agentId);
    return this.serialized(`mcp:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "set-mcp-server-enabled");
      return this.withFileLock(paths, path.join(paths.mcp, ".index.lock"), async () => {
        const index = await this.readMcpServerIndex(input.agentId);
        const server = index.servers.find((candidate) => candidate.id === input.serverId);
        if (!server) throw storeError(404, "MCP_SERVER_NOT_FOUND", "MCP 服务不存在。");
        if (server.enabled === input.enabled) return server;
        const updated = { ...server, enabled: input.enabled };
        await this.pathGuard.guard(paths, "set-mcp-server-enabled-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(index.servers.map((candidate) =>
          candidate.id === input.serverId ? updated : candidate
        )));
        return updated;
      });
    });
  }

  async removeMcpServer(input: { agentId: string; serverId: string }) {
    await this.ensureLayout(input.agentId);
    return this.serialized(`mcp:${input.agentId}`, async () => {
      const paths = await this.pathGuard.paths(input.agentId);
      await this.pathGuard.guard(paths, "remove-mcp-server");
      return this.withFileLock(paths, path.join(paths.mcp, ".index.lock"), async () => {
        const index = await this.readMcpServerIndex(input.agentId);
        const server = index.servers.find((candidate) => candidate.id === input.serverId);
        if (!server) throw storeError(404, "MCP_SERVER_NOT_FOUND", "MCP 服务不存在。");
        await this.pathGuard.guard(paths, "remove-mcp-server-commit");
        await atomicJson(paths.mcpIndex, withMcpRevision(index.servers.filter((candidate) =>
          candidate.id !== input.serverId
        )));
        return server;
      });
    });
  }

  private async publishSkillLocked(
    paths: StorePaths,
    record: AgentSkillRecord,
    stage: string,
    replace: boolean
  ) {
    await recoverSkillTransactions(this.skillPersistence(paths));
    const index = await readSkillIndexFile(this.skillPersistence(paths), true);
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
    await this.pathGuard.guard(paths, "publish-skill-commit");
    await atomicJson(journal, transaction);
    try {
      if (previous) {
        await moveVerifiedSkillDirectory({
          source: target,
          destination: backup,
          expectedDigest: previous.digestSha256,
          limits: this.options.archiveLimits,
          hooks: {
            beforeRename: () => this.fault("before-skill-backup-rename"),
            afterRename: () => this.fault("after-skill-backup-rename")
          }
        });
      }
      await moveVerifiedSkillDirectory({
        source: stage,
        destination: target,
        expectedDigest: record.digestSha256,
        limits: this.options.archiveLimits,
        hooks: {
          beforeRename: () => this.fault("before-skill-target-rename"),
          afterRename: () => this.fault("after-skill-target-rename")
        }
      });
      await syncDirectory(paths.skills);
      await this.fault("after-skill-directory-publish");
      const skills = [...index.skills.filter((skill) => skill.id !== record.id), record]
        .sort((left, right) => compareBinaryText(left.id, right.id));
      await atomicJson(paths.skillIndex, withSkillRevision(skills));
      await this.fault("after-skill-index-publish");
      await retainTerminalSkillJournal(journal, transaction, "committed");
      await syncDirectory(paths.skills);
      return record;
    } catch (error) {
      const current = await readSkillIndexFile(this.skillPersistence(paths), false);
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
          hooks: {
            beforeRename: () => this.fault("before-skill-target-quarantine-rename"),
            afterRename: () => this.fault("after-skill-target-quarantine-rename")
          }
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
            hooks: {
              beforeRename: () => this.fault("before-skill-backup-restore-rename"),
              afterRename: () => this.fault("after-skill-backup-restore-rename")
            }
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

  private async withFileLock<T>(paths: StorePaths, lockPath: string, operation: () => Promise<T>) {
    await this.pathGuard.guard(paths, "acquire-extension-lock");
    const lockParent = path.dirname(lockPath);
    const handle = await acquireFileLock(lockPath);
    await this.pathGuard.refresh(paths, { allowChanged: [lockParent] });
    try {
      return await operation();
    } finally {
      await handle.close();
      await this.pathGuard.refresh(paths, { allowChanged: [lockParent] });
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

  private async fault(step: string) {
    await this.options.faultInjector?.(step);
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

function withSkillRevision(skills: AgentSkillRecord[]): AgentSkillIndex {
  const ordered = [...skills].sort((left, right) => compareBinaryText(left.id, right.id));
  return { schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION, revision: extensionRevision(ordered), skills: ordered };
}

function withMcpRevision(servers: AgentMcpServerDescriptor[]): AgentMcpServerIndex {
  const ordered = [...servers].sort((left, right) => compareBinaryText(left.id, right.id));
  return { schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION, revision: extensionRevision(ordered), servers: ordered };
}

function validateSkillIndex(value: unknown) {
  const index = parseAgentSkillIndex(value);
  if (index.revision !== extensionRevision([...index.skills].sort((left, right) => compareBinaryText(left.id, right.id)))) {
    throw storeError(409, "SKILL_INDEX_REVISION_MISMATCH", "Skill 索引 revision 无效。");
  }
}

function validateMcpIndex(value: unknown) {
  const index = parseAgentMcpServerIndex(value);
  if (index.revision !== extensionRevision([...index.servers].sort((left, right) => compareBinaryText(left.id, right.id)))) {
    throw storeError(409, "MCP_INDEX_REVISION_MISMATCH", "MCP 服务索引 revision 无效。");
  }
}
