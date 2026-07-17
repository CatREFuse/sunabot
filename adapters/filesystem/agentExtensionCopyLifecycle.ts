import {
  AGENT_EXTENSION_SCHEMA_VERSION,
  compareBinaryText,
  type AgentExtensionCopyApplyResult,
  type AgentExtensionCopyConflictStrategy,
  type AgentMcpServerDescriptor,
  type AgentMcpServerIndex,
  type AgentSkillIndex,
  type AgentSkillRecord,
  type AgentSkillSource
} from "../../packages/contracts/extensions/agentExtensions.js";
import type { AgentMcpCredentialStatusResolver } from "../../services/extensions/public.js";
import { buildAgentExtensionCopyPreview } from "./agentExtensionPreview.js";
import {
  AgentExtensionCopyJournalStore,
  type AgentExtensionCopyJournal,
  type AgentExtensionCopyJournalHandle
} from "./agentExtensionCopyJournal.js";
import { AgentExtensionPathGuard } from "./agentExtensionPaths.js";
import { storeError } from "./agentExtensionSecureFs.js";
import { buildSkillCopyArchive, buildSkillCopyArtifact } from "./agentSkillCopyArchive.js";
import { safeSkillTarget } from "./agentSkillTransaction.js";
import { withMcpRevision } from "./agentMcpServerStore.js";
import { extensionRevision } from "./agentSkillPersistence.js";
import { inspectSkillDirectory, type SkillArchiveLimits } from "./skillArchive.js";

interface AgentExtensionCopyRepository {
  readSkillIndex(agentId: string): Promise<AgentSkillIndex>;
  readMcpServerIndex(agentId: string): Promise<AgentMcpServerIndex>;
  installSkill(input: {
    agentId: string;
    archive: Buffer;
    replace: boolean;
    source?: AgentSkillSource;
    expectedIndexRevision?: string;
  }): Promise<AgentSkillRecord>;
  setSkillEnabled(input: { agentId: string; skillId: string; enabled: boolean }): Promise<AgentSkillRecord>;
  restoreReviewedSkill(input: { agentId: string; previous: AgentSkillRecord }): Promise<AgentSkillRecord>;
  restoreSkillRecord(input: { agentId: string; previous: AgentSkillRecord }): Promise<AgentSkillRecord>;
  uninstallSkill(input: {
    agentId: string;
    skillId: string;
    expectedIndexRevision?: string;
  }): Promise<AgentSkillRecord>;
  putMcpServer(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
    replace: boolean;
    expectedIndexRevision?: string;
  }): Promise<AgentMcpServerDescriptor>;
  removeMcpServer(input: {
    agentId: string;
    serverId: string;
    expectedIndexRevision?: string;
  }): Promise<AgentMcpServerDescriptor>;
}

interface AgentExtensionCopyLifecycleOptions {
  repository: AgentExtensionCopyRepository;
  pathGuard: AgentExtensionPathGuard;
  archiveLimits?: SkillArchiveLimits;
  fault?: (step: string) => void | Promise<void>;
}

interface CopySelection {
  sourceAgentId: string;
  targetAgentId: string;
  skillId: string;
  mcpServerIds: string[];
  credentialStatus: AgentMcpCredentialStatusResolver;
}

export class AgentExtensionCopyLifecycle {
  private readonly journals: AgentExtensionCopyJournalStore;

  constructor(private readonly options: AgentExtensionCopyLifecycleOptions) {
    this.journals = new AgentExtensionCopyJournalStore(options.pathGuard, options.fault);
  }

  async preview(input: CopySelection) {
    const [sourceSkills, targetSkills, sourceMcp, targetMcp] = await Promise.all([
      this.options.repository.readSkillIndex(input.sourceAgentId),
      this.options.repository.readSkillIndex(input.targetAgentId),
      this.options.repository.readMcpServerIndex(input.sourceAgentId),
      this.options.repository.readMcpServerIndex(input.targetAgentId)
    ]);
    const sourcePaths = await this.options.pathGuard.paths(input.sourceAgentId);
    await this.options.pathGuard.guard(sourcePaths, "preview-skill-copy");
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

  async recover(targetAgentId: string) {
    for (const entry of await this.journals.active(targetAgentId)) {
      const handle = { id: entry.journal.id, targetAgentId };
      if (entry.journal.state === "prepared") {
        await this.rollbackPrepared(entry.journal, entry.skills);
        await this.journals.terminalize(handle, "rolled_back");
        continue;
      }
      const [skills, mcp] = await Promise.all([
        this.options.repository.readSkillIndex(targetAgentId),
        this.options.repository.readMcpServerIndex(targetAgentId)
      ]);
      const expectedSkills = entry.journal.state === "committed"
        ? entry.journal.afterSkillIndex
        : entry.journal.beforeSkillIndex;
      const expectedMcp = entry.journal.state === "committed"
        ? entry.journal.afterMcpIndex
        : entry.journal.beforeMcpIndex;
      if (!expectedSkills || !same(skills, expectedSkills) || !same(mcp, expectedMcp)) recoveryRequired();
      await this.journals.terminalize(handle, entry.journal.state);
    }
  }

  async apply(input: CopySelection & {
    previewRevision: string;
    conflictStrategy: AgentExtensionCopyConflictStrategy;
    renameTo?: string;
  }): Promise<AgentExtensionCopyApplyResult> {
    this.validateRequest(input);
    const preview = await this.preview(input);
    if (preview.previewRevision !== input.previewRevision) {
      throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制预览已过期，请重新确认。");
    }
    const [sourceSkills, targetSkills, sourceMcp, targetMcp] = await Promise.all([
      this.options.repository.readSkillIndex(input.sourceAgentId),
      this.options.repository.readSkillIndex(input.targetAgentId),
      this.options.repository.readMcpServerIndex(input.sourceAgentId),
      this.options.repository.readMcpServerIndex(input.targetAgentId)
    ]);
    if (sourceSkills.revision !== preview.sourceSkillRevision ||
        targetSkills.revision !== preview.targetSkillRevision ||
        sourceMcp.revision !== preview.sourceMcpRevision ||
        targetMcp.revision !== preview.targetMcpRevision) {
      throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制预览已过期，请重新确认。");
    }
    const sourcePaths = await this.options.pathGuard.paths(input.sourceAgentId);
    const targetPaths = await this.options.pathGuard.paths(input.targetAgentId);
    await Promise.all([
      this.options.pathGuard.guard(sourcePaths, "copy-skill-source"),
      this.options.pathGuard.guard(targetPaths, "copy-skill-target")
    ]);
    const targetSkillId = input.renameTo ?? input.skillId;
    if (input.conflictStrategy === "rename" && targetSkills.skills.some((skill) => skill.id === targetSkillId)) {
      throw storeError(409, "SKILL_CONFLICT", "目标 Agent 已存在同名 Skill。");
    }
    const sourceArtifact = await buildSkillCopyArtifact({
      directory: safeSkillTarget(sourcePaths.skills, input.skillId),
      expectedDigestSha256: preview.skill.contentVersion,
      ...(input.renameTo ? { renameTo: input.renameTo } : {}),
      limits: this.options.archiveLimits
    });
    let previousArchive: Buffer | undefined;
    try {
      const previousSkill = targetSkills.skills.find((skill) => skill.id === targetSkillId);
      previousArchive = previousSkill ? await buildSkillCopyArchive({
        directory: safeSkillTarget(targetPaths.skills, previousSkill.id),
        expectedDigestSha256: previousSkill.digestSha256,
        limits: this.options.archiveLimits
      }) : undefined;
      const selectedMcp = preview.selectedMcpServers.filter((selected) =>
        selected.conflict === "none" || input.conflictStrategy !== "skip");
      const afterMcpIndex = withMcpRevision(selectedMcp.reduce(
        (servers, selected) => [...servers.filter((server) => server.id !== selected.server.id), selected.server],
        [...targetMcp.servers]
      ));
      const skillWillChange = preview.skill.conflict === "none" || input.conflictStrategy !== "skip";
      const handle = await this.journals.begin({
        sourceAgentId: input.sourceAgentId,
        targetAgentId: input.targetAgentId,
        previewRevision: preview.previewRevision,
        sourceSkillRevision: preview.sourceSkillRevision,
        targetSkillRevision: preview.targetSkillRevision,
        sourceMcpRevision: preview.sourceMcpRevision,
        targetMcpRevision: preview.targetMcpRevision,
        conflictStrategy: input.conflictStrategy,
        targetSkillId,
        sourceSkillId: input.skillId,
        skillWillChange,
        expectedSkillDigestSha256: sourceArtifact.digestSha256,
        beforeSkillIndex: targetSkills,
        beforeMcpIndex: targetMcp,
        afterMcpIndex,
        changedMcpServerIds: selectedMcp.map((selected) => selected.server.id),
        sourceArchive: sourceArtifact.archive,
        ...(previousArchive ? { previousArchive } : {})
      });
      return await this.applyWithRollback({
        input,
        preview,
        targetSkills,
        targetMcp,
        sourceArchive: sourceArtifact.archive,
        previousSkill,
        previousArchive,
        handle
      });
    } finally {
      sourceArtifact.archive.fill(0);
      previousArchive?.fill(0);
    }
  }

  private async applyWithRollback(options: {
    input: CopySelection & {
      previewRevision: string;
      conflictStrategy: AgentExtensionCopyConflictStrategy;
      renameTo?: string;
    };
    preview: Awaited<ReturnType<AgentExtensionCopyLifecycle["preview"]>>;
    targetSkills: AgentSkillIndex;
    targetMcp: AgentMcpServerIndex;
    sourceArchive: Buffer;
    previousSkill?: AgentSkillRecord;
    previousArchive?: Buffer;
    handle: AgentExtensionCopyJournalHandle;
  }): Promise<AgentExtensionCopyApplyResult> {
    const { input, preview, targetSkills, targetMcp, sourceArchive, previousSkill, previousArchive, handle } = options;
    const appliedMcp: AgentMcpServerDescriptor[] = [];
    let installed: AgentSkillRecord | null = null;
    let skipped = false;
    try {
      if (preview.skill.conflict !== "none" && input.conflictStrategy === "skip") {
        skipped = true;
      } else {
        installed = await this.options.repository.installSkill({
          agentId: input.targetAgentId,
          archive: sourceArchive,
          replace: input.conflictStrategy === "replace",
          source: { kind: "copy", agentId: input.sourceAgentId, skillId: input.skillId },
          expectedIndexRevision: targetSkills.revision
        });
      }
      const expectedAfterSkillIndex = skillIndexAfterCopy(targetSkills, installed);
      const actualAfterSkillIndex = await this.options.repository.readSkillIndex(input.targetAgentId);
      if (!same(actualAfterSkillIndex, expectedAfterSkillIndex)) {
        throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制目标 Skill 索引已变化。");
      }
      await this.journals.recordSkillIndex(handle, expectedAfterSkillIndex);
      await this.options.fault?.("after-copy-skill-install");
      let expectedMcpRevision = targetMcp.revision;
      let currentMcp = [...targetMcp.servers];
      let mcpIndex = 0;
      for (const selected of preview.selectedMcpServers) {
        if (selected.conflict !== "none" && input.conflictStrategy === "skip") continue;
        const current = await this.options.repository.putMcpServer({
          agentId: input.targetAgentId,
          server: selected.server,
          replace: input.conflictStrategy === "replace",
          expectedIndexRevision: expectedMcpRevision
        });
        appliedMcp.push(current);
        currentMcp = [...currentMcp.filter((server) => server.id !== current.id), current];
        expectedMcpRevision = withMcpRevision(currentMcp).revision;
        await this.options.fault?.(`after-copy-mcp-put-${mcpIndex}`);
        mcpIndex += 1;
      }
      const result = {
        schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION,
        sourceAgentId: input.sourceAgentId,
        targetAgentId: input.targetAgentId,
        skill: installed,
        skipped,
        mcpServers: appliedMcp
      };
      await this.options.fault?.("before-copy-transaction-finalize");
      const finalJournal = (await this.journals.get(handle)).journal;
      if (!same(await this.options.repository.readMcpServerIndex(input.targetAgentId), finalJournal.afterMcpIndex)) {
        throw storeError(409, "AGENT_EXTENSION_COPY_PREVIEW_STALE", "复制目标 MCP 索引已变化。");
      }
      await this.journals.terminalize(handle, "committed");
      return result;
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      const active = await this.journals.get(handle);
      if (active.journal.state !== "prepared") throw error;
      await this.rollbackPrepared(active.journal, active.skills);
      await this.journals.terminalize(handle, "rolled_back");
      throw error;
    }
  }

  private async rollbackPrepared(journal: AgentExtensionCopyJournal, skillsDirectory: string) {
    try {
      for (const serverId of [...journal.changedMcpServerIds].reverse()) {
        const currentIndex = await this.options.repository.readMcpServerIndex(journal.targetAgentId);
        assertMcpRecoveryState(journal, currentIndex);
        const current = currentIndex.servers.find((server) => server.id === serverId);
        const before = journal.beforeMcpIndex.servers.find((server) => server.id === serverId);
        const after = journal.afterMcpIndex.servers.find((server) => server.id === serverId);
        if (same(current, before)) continue;
        if (!same(current, after)) recoveryRequired();
        if (before) {
          await this.options.repository.putMcpServer({
            agentId: journal.targetAgentId,
            server: before,
            replace: true,
            expectedIndexRevision: currentIndex.revision
          });
        } else {
          await this.options.repository.removeMcpServer({
            agentId: journal.targetAgentId,
            serverId,
            expectedIndexRevision: currentIndex.revision
          });
        }
      }
      if (!same(await this.options.repository.readMcpServerIndex(journal.targetAgentId), journal.beforeMcpIndex)) {
        recoveryRequired();
      }

      let currentSkills = await this.options.repository.readSkillIndex(journal.targetAgentId);
      if (!same(currentSkills, journal.beforeSkillIndex)) {
        if (!journal.skillWillChange) recoveryRequired();
        assertSkillRecoveryState(journal, currentSkills);
        const current = currentSkills.skills.find((skill) => skill.id === journal.targetSkillId);
        const before = journal.beforeSkillIndex.skills.find((skill) => skill.id === journal.targetSkillId);
        if (current && !same(current, before)) {
          await this.options.repository.uninstallSkill({
            agentId: journal.targetAgentId,
            skillId: journal.targetSkillId,
            expectedIndexRevision: currentSkills.revision
          });
          currentSkills = await this.options.repository.readSkillIndex(journal.targetAgentId);
        }
        if (before) {
          if (!journal.previousArchive) recoveryRequired();
          const archive = await this.journals.readArchive(skillsDirectory, journal.previousArchive);
          try {
            await this.options.repository.installSkill({
              agentId: journal.targetAgentId,
              archive,
              replace: false,
              source: before.source,
              expectedIndexRevision: currentSkills.revision
            });
          } finally {
            archive.fill(0);
          }
          await this.options.repository.restoreSkillRecord({
            agentId: journal.targetAgentId,
            previous: before
          });
        }
      }
      const [skills, mcp] = await Promise.all([
        this.options.repository.readSkillIndex(journal.targetAgentId),
        this.options.repository.readMcpServerIndex(journal.targetAgentId)
      ]);
      if (!same(skills, journal.beforeSkillIndex) || !same(mcp, journal.beforeMcpIndex)) recoveryRequired();
    } catch (error) {
      if (isRecoveryRequired(error)) throw error;
      throw storeError(409, "AGENT_EXTENSION_COPY_ROLLBACK_FAILED", "复制失败且目标回滚未完成。");
    }
  }

  private validateRequest(input: {
    sourceAgentId: string;
    targetAgentId: string;
    conflictStrategy: AgentExtensionCopyConflictStrategy;
    renameTo?: string;
  }) {
    if (input.sourceAgentId === input.targetAgentId) {
      throw storeError(409, "AGENT_EXTENSION_COPY_TARGET_INVALID", "Skill 复制目标必须是其他 Agent。");
    }
    if (input.conflictStrategy === "rename" && !input.renameTo) {
      throw storeError(400, "AGENT_EXTENSION_COPY_RENAME_REQUIRED", "重命名复制需要新的 Skill 名称。");
    }
    if (input.conflictStrategy !== "rename" && input.renameTo) {
      throw storeError(400, "AGENT_EXTENSION_COPY_RENAME_INVALID", "当前冲突策略不接受新 Skill 名称。");
    }
  }
}

function isSimulatedCrash(error: unknown) {
  return Boolean(error && typeof error === "object" &&
    (error as { code?: unknown }).code === "AGENT_EXTENSION_COPY_SIMULATED_CRASH");
}

function skillIndexAfterCopy(before: AgentSkillIndex, installed: AgentSkillRecord | null): AgentSkillIndex {
  if (!installed) return structuredClone(before);
  const skills = [...before.skills.filter((skill) => skill.id !== installed.id), installed]
    .sort((left, right) => compareBinaryText(left.id, right.id));
  return { schemaVersion: AGENT_EXTENSION_SCHEMA_VERSION, revision: extensionRevision(skills), skills };
}

function assertMcpRecoveryState(journal: AgentExtensionCopyJournal, current: AgentMcpServerIndex) {
  const changed = new Set(journal.changedMcpServerIds);
  const ids = new Set([
    ...journal.beforeMcpIndex.servers.map((server) => server.id),
    ...journal.afterMcpIndex.servers.map((server) => server.id),
    ...current.servers.map((server) => server.id)
  ]);
  for (const id of ids) {
    const value = current.servers.find((server) => server.id === id);
    const before = journal.beforeMcpIndex.servers.find((server) => server.id === id);
    const after = journal.afterMcpIndex.servers.find((server) => server.id === id);
    if (changed.has(id)) {
      if (!same(value, before) && !same(value, after)) recoveryRequired();
    } else if (!same(value, before)) {
      recoveryRequired();
    }
  }
}

function assertSkillRecoveryState(journal: AgentExtensionCopyJournal, current: AgentSkillIndex) {
  const before = journal.beforeSkillIndex.skills.filter((skill) => skill.id !== journal.targetSkillId);
  const unrelated = current.skills.filter((skill) => skill.id !== journal.targetSkillId);
  if (!same(unrelated, before)) recoveryRequired();
  const currentTarget = current.skills.find((skill) => skill.id === journal.targetSkillId);
  const beforeTarget = journal.beforeSkillIndex.skills.find((skill) => skill.id === journal.targetSkillId);
  if (!currentTarget || same(currentTarget, beforeTarget)) return;
  const afterTarget = journal.afterSkillIndex?.skills.find((skill) => skill.id === journal.targetSkillId);
  if (afterTarget && same(currentTarget, afterTarget)) return;
  if (currentTarget.digestSha256 !== journal.expectedSkillDigestSha256 ||
      currentTarget.source.kind !== "copy" || currentTarget.source.agentId !== journal.sourceAgentId ||
      currentTarget.source.skillId !== journal.sourceSkillId || currentTarget.enabled ||
      currentTarget.riskEvidence.reviewStatus !== "unreviewed" ||
      currentTarget.approval?.status !== "unapproved") recoveryRequired();
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecoveryRequired(error: unknown) {
  return Boolean(error && typeof error === "object" &&
    (error as { code?: unknown }).code === "AGENT_EXTENSION_COPY_RECOVERY_REQUIRED");
}

function recoveryRequired(): never {
  throw storeError(409, "AGENT_EXTENSION_COPY_RECOVERY_REQUIRED", "复制事务需要人工恢复。");
}
