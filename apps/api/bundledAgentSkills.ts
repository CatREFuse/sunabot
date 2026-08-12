import path from "node:path";
import { buildSkillCopyArtifact } from "../../adapters/filesystem/agentSkillCopyArchive.js";
import type { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import { inspectSkillDirectory } from "../../adapters/filesystem/skillArchive.js";
import type { AgentSkillRecord } from "../../packages/contracts/extensions/agentExtensions.js";
import { getRootDir } from "../../packages/platform/projectPaths.js";
import { DeterministicSkillReviewAuditRunner } from "../../services/extensions/public.js";

export const WORKBENCH_CONFIG_SKILL_ID = "workbench-config";
const WORKBENCH_CONFIG_BUNDLE_ID = "workbench-config";

export class BundledAgentSkillInstaller {
  private readonly review = new DeterministicSkillReviewAuditRunner();
  private sourceArtifact?: Promise<{ archive: Buffer; digestSha256: string }>;

  constructor(
    private readonly store: AgentExtensionStore,
    private readonly sourceDirectory = path.join(
      getRootDir(),
      "codex-skills",
      WORKBENCH_CONFIG_SKILL_ID
    )
  ) {}

  async ensure(agentId: string) {
    const source = await this.loadSourceArtifact();
    const archive = Buffer.from(source.archive);
    try {
      await this.store.ensureLayout(agentId);
      const index = await this.store.readSkillIndex(agentId);
      const current = index.skills.find((skill) => skill.id === WORKBENCH_CONFIG_SKILL_ID);
      const installed = await this.ensureInstalled(agentId, current, archive, source.digestSha256);
      return await this.ensureApprovedAndEnabled(agentId, installed);
    } finally {
      archive.fill(0);
    }
  }

  private loadSourceArtifact() {
    this.sourceArtifact ??= inspectSkillDirectory(this.sourceDirectory).then((evidence) => (
      buildSkillCopyArtifact({
        directory: this.sourceDirectory,
        expectedDigestSha256: evidence.digestSha256
      })
    ));
    return this.sourceArtifact;
  }

  private async ensureInstalled(
    agentId: string,
    current: AgentSkillRecord | undefined,
    archive: Buffer,
    digestSha256: string
  ) {
    if (
      current?.digestSha256 === digestSha256
      && current.source.kind === "bundled"
      && current.source.bundleId === WORKBENCH_CONFIG_BUNDLE_ID
    ) {
      return current;
    }
    if (current && current.source.kind !== "bundled") {
      throw bundledSkillError("BUNDLED_SKILL_CONFLICT");
    }
    return this.store.installSkill({
      agentId,
      archive,
      replace: Boolean(current),
      source: { kind: "bundled", bundleId: WORKBENCH_CONFIG_BUNDLE_ID }
    });
  }

  private async ensureApprovedAndEnabled(agentId: string, current: AgentSkillRecord) {
    if (doublyApproved(current)) {
      return current.enabled ? current : this.store.setSkillEnabled({
        agentId,
        skillId: current.id,
        enabled: true
      });
    }
    const prepared = await this.store.prepareSkillReview({
      agentId,
      skillId: current.id
    });
    try {
      const decision = await this.review.review({
        ...prepared,
        administratorApproved: true
      });
      if (!decision.approved || decision.digestSha256 !== prepared.digestSha256) {
        throw bundledSkillError("BUNDLED_SKILL_REVIEW_REJECTED");
      }
      await this.store.commitSkillReview({
        agentId,
        skillId: current.id,
        expectedIndexRevision: prepared.indexRevision,
        expectedDigestSha256: prepared.digestSha256,
        expectedFiles: prepared.files,
        auditDigestSha256: decision.digestSha256
      });
      return this.store.setSkillEnabled({
        agentId,
        skillId: current.id,
        enabled: true
      });
    } finally {
      for (const item of [...prepared.scripts, ...prepared.texts]) item.content.fill(0);
    }
  }
}

function doublyApproved(record: AgentSkillRecord) {
  return record.riskEvidence.reviewStatus === "approved"
    && record.riskEvidence.reviewedDigestSha256 === record.digestSha256
    && record.approval?.status === "approved"
    && record.approval.digestSha256 === record.digestSha256;
}

function bundledSkillError(code: "BUNDLED_SKILL_CONFLICT" | "BUNDLED_SKILL_REVIEW_REJECTED") {
  const error = new Error(code);
  error.name = "BundledAgentSkillError";
  return error;
}
