#!/usr/bin/env node

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createRecoveryPoint,
  restoreRecoveryPoint,
  verifyRecoveryPoint
} from "../workspace/sqlite-recovery.mjs";

export const MIGRATION_ID = "memory-perspective-v1";
export const EXPORT_SCHEMA_VERSION = 1;
export const PROPOSAL_SCHEMA_VERSION = 2;
export const PLAN_SCHEMA_VERSION = 3;

const SOURCES = ["working", "long_term", "user_profile"];
const ACTIONS = new Set(["keep", "merge", "delete"]);
const METADATA_PATCH_KEYS = ["preserveFromBase", "remove", "set"];
const EXPORT_KEYS = [
  "agents", "exportSha256", "generatedAt", "migrationId", "schemaVersion", "workspaceLayout"
];
const EXPORT_AGENT_KEYS = [
  "agentId", "counts", "database", "queueDatabase", "rows", "sourceSha256",
  "stableSha256", "stableSourceSha256"
];
const EXPORT_ROW_KEYS = [
  "effectiveData", "effectiveId", "position", "recordId", "rowId", "source", "stableKey", "wrapper"
];
const PROPOSAL_KEYS = new Set([
  "schemaVersion", "migrationId", "agentId", "database", "sourceExport", "sourceExportSha256",
  "sourceStableSha256", "generator", "inputs", "targets", "rowActions", "unresolved", "proposalSha256"
]);
const PLAN_KEYS = new Set([
  "schemaVersion", "migrationId", "generatedAt", "agentId", "database", "queueDatabase",
  "sourceExport", "sourceExportSha256", "sourceProposal", "proposalSha256", "baseline", "targets",
  "rowActions", "unresolved", "replacements", "replacementSha256", "planSha256"
]);
const TARGET_LIMITS = {
  working: { min: 0, max: 8 },
  long_term: { min: 0, max: 8 },
  user_profile: { min: 0, max: Number.MAX_SAFE_INTEGER }
};
const MUTABLE_METADATA_FIELDS = new Set([
  "userIds",
  "userName",
  "sourceWorkingMemoryIds",
  "sourceCandidateIds",
  "longTermId",
  "eventFingerprint",
  "eventKey"
]);
const DERIVED_EVENT_TIME_FIELDS = new Set(["occurredAt", "occurredEndAt"]);
const IMMUTABLE_METADATA_FIELDS = new Set([
  "userId",
  "addressName",
  "source",
  "batchId",
  "batch_id",
  "conversationId",
  "conversation_id",
  "createdAt",
  "observedAt",
  "time"
]);
const SIGNATURE_FIELDS = {
  export: "exportSha256",
  proposal: "proposalSha256",
  plan: "planSha256"
};
const PRE_INSTALL_STATES = new Set([
  "awaiting-backup",
  "prepared",
  "staging-restored",
  "staging-applying",
  "staging-failed",
  "staged-ready"
]);
const OPERATION_LOCK_SCHEMA_VERSION = 1;
const OPERATION_LOCK_KIND = "memory-perspective-operation-lock";
const OPERATION_LOCK_MAX_BYTES = 1_024;
const OPERATION_LOCK_MAX_ARTIFACTS = 32;
const OPERATION_LOCK_MAX_ATTEMPTS = 16;
const OPERATION_LOCK_KEYS = [
  "kind",
  "migrationId",
  "ownerToken",
  "pid",
  "processIdentity",
  "schemaVersion"
];
const DATABASE_OPEN_POLICY = new AsyncLocalStorage();

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "MEMORY_PERSPECTIVE_MIGRATION_FAILED",
      message: error?.message ?? String(error),
      details: error?.details
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { command, values, flags } = parseArguments(argv);
  let result;
  if (command === "export") {
    result = exportBaseline({
      workspace: requiredValue(values, "workspace"),
      output: requiredValue(values, "output")
    });
  } else if (command === "generate") {
    result = generateProposals({
      exportFile: requiredValue(values, "export"),
      proposalDir: requiredValue(values, "proposal-dir")
    });
  } else if (command === "sign") {
    result = signProposalDirectory({ proposalDir: requiredValue(values, "proposal-dir") });
  } else if (command === "refresh") {
    result = refreshPlans({
      workspace: requiredValue(values, "workspace"),
      proposalDir: requiredValue(values, "proposal-dir"),
      planDir: requiredValue(values, "plan-dir")
    });
  } else if (command === "dry-run") {
    result = dryRunPlans({
      workspace: requiredValue(values, "workspace"),
      planDir: requiredValue(values, "plan-dir")
    });
  } else if (command === "prepare") {
    result = await prepareMigration({
      workspace: requiredValue(values, "workspace"),
      planDir: requiredValue(values, "plan-dir"),
      backup: values.get("backup"),
      quiesced: flags.has("quiesced")
    });
  } else if (command === "apply") {
    result = await applyMigration({
      workspace: requiredValue(values, "workspace"),
      planDir: requiredValue(values, "plan-dir"),
      backup: requiredValue(values, "backup"),
      stagingWorkspace: requiredValue(values, "staging-workspace"),
      report: values.get("report"),
      quiesced: flags.has("quiesced")
    });
  } else if (command === "verify") {
    result = await verifyMigration({
      workspace: requiredValue(values, "workspace"),
      planDir: requiredValue(values, "plan-dir"),
      report: values.get("report"),
      quiesced: flags.has("quiesced")
    });
  } else if (command === "rollback") {
    result = await stageRollback({
      workspace: requiredValue(values, "workspace"),
      backup: requiredValue(values, "backup"),
      targetWorkspace: requiredValue(values, "target-workspace"),
      quiesced: flags.has("quiesced")
    });
  } else if (command === "install") {
    result = await installStagedMigration({
      workspace: requiredValue(values, "workspace"),
      stagingWorkspace: requiredValue(values, "staging-workspace"),
      quiesced: flags.has("quiesced"),
      confirmReplace: flags.has("confirm-replace")
    });
  } else if (command === "abort") {
    result = await abortMigration({
      workspace: requiredValue(values, "workspace"),
      quiesced: flags.has("quiesced")
    });
  } else if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  } else {
    throw migrationError("ARGUMENT_INVALID", `未知命令：${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function exportBaseline(options) {
  const workspace = resolveWorkspace(options.workspace);
  const output = resolveWorkspaceOutput(workspace, options.output, "output");
  const definitions = discoverDatabasePairFiles(workspace);
  const agents = withReadOnlyDatabaseSnapshot(workspace, definitions, [], (snapshotWorkspace) => {
    const snapshotDefinitions = discoverDatabasePairs(snapshotWorkspace);
    assertDefinitionSetsEqual(definitions, snapshotDefinitions, "EXPORT_DATABASE_SET_MISMATCH");
    return snapshotDefinitions.map((definition) => inspectAgentMemory(snapshotWorkspace, definition));
  });
  const payload = signDocument({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    migrationId: MIGRATION_ID,
    generatedAt: new Date().toISOString(),
    workspaceLayout: "business-v1",
    agents
  }, SIGNATURE_FIELDS.export);
  writeJsonAtomicDurable(output, payload);
  return {
    ok: true,
    command: "export",
    output: workspaceRelative(workspace, output),
    exportSha256: payload.exportSha256,
    agents: agents.map(publicAgentBaseline)
  };
}

export function generateProposals(options) {
  const exportFile = fs.realpathSync(resolveExistingFile(options.exportFile, "export"));
  const snapshot = readSignedJson(exportFile, SIGNATURE_FIELDS.export);
  validateExport(snapshot);
  const workspace = inferWorkspaceFromExport(exportFile);
  const proposalDir = resolveWorkspaceOutput(workspace, options.proposalDir, "proposal-dir");
  ensureEmptyOrMissingDirectory(proposalDir);
  fs.mkdirSync(proposalDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const agent of snapshot.agents) {
    const inputs = proposalInputsFromExportAgent(agent);
    const proposal = signDocument({
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      migrationId: MIGRATION_ID,
      agentId: agent.agentId,
      database: agent.database,
      sourceExport: workspaceRelative(workspace, exportFile),
      sourceExportSha256: snapshot.exportSha256,
      sourceStableSha256: agent.stableSha256,
      generator: {
        kind: "unresolved-skeleton",
        providerCalled: false,
        model: null
      },
      inputs,
      targets: Object.fromEntries(SOURCES.map((source) => [source, []])),
      rowActions: inputs.map((input) => ({
        stableKey: input.stableKey,
        source: input.source,
        effectiveId: input.effectiveId,
        action: "unresolved",
        targetId: null,
        originalSummary: input.originalSummary,
        reason: "待按角色第一人称直接重整，禁止“我记得”，保证昵称与 QQ 同时存在，并把相近、重复或因果信息压成一条且保留最早至最新时间关系"
      })),
      unresolved: inputs.map((input) => input.stableKey)
    }, SIGNATURE_FIELDS.proposal);
    const file = path.join(proposalDir, `${agent.agentId}.proposal.json`);
    writeJsonAtomicDurable(file, proposal);
    files.push(workspaceRelative(workspace, file));
  }
  return {
    ok: true,
    command: "generate",
    proposalDir: workspaceRelative(workspace, proposalDir),
    files,
    unresolved: snapshot.agents.reduce((total, agent) => total + agent.rows.length, 0)
  };
}

export function signProposalDirectory(options) {
  const proposalDir = fs.realpathSync(resolveExistingDirectory(options.proposalDir, "proposal-dir"));
  const workspace = inferWorkspaceFromArtifact(proposalDir, "proposal-dir");
  if (!isInside(workspace, proposalDir)) {
    throw migrationError("INPUT_PATH_UNSAFE", "proposal-dir 必须位于所属 workspace 内");
  }
  const files = listNamedJson(proposalDir, ".proposal.json");
  if (!files.length) throw migrationError("PROPOSAL_SET_EMPTY", "proposal-dir 中没有 proposal 文件");
  const pending = [];
  const exportCache = new Map();
  for (const file of files) {
    const proposal = readJson(file);
    validateProposalShape(proposal, { allowUnresolved: true, verifySignature: false });
    const snapshot = validateProposalExportBinding(workspace, proposal, exportCache);
    const next = signDocument(proposal, SIGNATURE_FIELDS.proposal);
    pending.push({ file, next, snapshot });
  }
  const exports = new Set(pending.map((entry) => entry.next.sourceExport));
  if (exports.size !== 1) {
    throw migrationError("PROPOSAL_EXPORT_SET_MISMATCH", "proposal 集合必须绑定同一份 signed export");
  }
  const expectedAgents = pending[0].snapshot.agents.map((agent) => agent.agentId).sort();
  const actualAgents = pending.map((entry) => entry.next.agentId).sort();
  if (stableJson(expectedAgents) !== stableJson(actualAgents)) {
    throw migrationError("PROPOSAL_AGENT_SET_MISMATCH", "proposal 文件集合与 signed export Agent 集合不一致");
  }
  const signed = [];
  for (const { file, next } of pending) {
    writeJsonAtomicDurable(file, next);
    signed.push({ file: path.basename(file), proposalSha256: next.proposalSha256 });
  }
  return { ok: true, command: "sign", signed };
}

export function refreshPlans(options) {
  const workspace = resolveWorkspace(options.workspace);
  const proposalDir = resolveWorkspaceInput(workspace, options.proposalDir, "proposal-dir");
  const planDir = resolveWorkspaceOutput(workspace, options.planDir, "plan-dir");
  const definitions = discoverDatabasePairFiles(workspace);
  const proposals = readExactAgentDocuments(proposalDir, ".proposal.json", definitions, SIGNATURE_FIELDS.proposal);
  ensureEmptyOrMissingDirectory(planDir);
  for (const proposal of proposals.values()) validateProposalShape(proposal, { allowUnresolved: false, verifySignature: true });
  const artifactFiles = collectProposalArtifactFiles(workspace, proposalDir, proposals);
  const generated = withReadOnlyDatabaseSnapshot(workspace, definitions, artifactFiles, (snapshotWorkspace) => {
    const snapshotDefinitions = discoverDatabasePairs(snapshotWorkspace);
    assertDefinitionSetsEqual(definitions, snapshotDefinitions, "REFRESH_DATABASE_SET_MISMATCH");
    const snapshotProposalDir = safeWorkspaceChild(snapshotWorkspace, workspaceRelative(workspace, proposalDir));
    const snapshotProposals = readExactAgentDocuments(
      snapshotProposalDir,
      ".proposal.json",
      snapshotDefinitions,
      SIGNATURE_FIELDS.proposal
    );
    return snapshotDefinitions.map((definition) => {
      const proposal = snapshotProposals.get(definition.agentId);
      validateProposalShape(proposal, { allowUnresolved: false, verifySignature: true });
      validateProposalExportBinding(snapshotWorkspace, proposal);
      if (proposal.database !== definition.application) {
        throw migrationError("PROPOSAL_DATABASE_MISMATCH", `${definition.agentId}: proposal database 与当前 workspace 不一致`);
      }
      const inspection = inspectAgentMemory(snapshotWorkspace, definition);
      const plan = bindProposalToCurrentRows(proposal, inspection, {
        sourceProposal: workspaceRelative(workspace, path.join(proposalDir, `${definition.agentId}.proposal.json`))
      });
      validatePlanArtifactBinding(snapshotWorkspace, plan);
      return { definition, plan };
    });
  });
  fs.mkdirSync(planDir, { recursive: true, mode: 0o700 });
  const output = generated.map(({ definition, plan }) => {
    const file = path.join(planDir, `${definition.agentId}.plan.json`);
    writeJsonAtomicDurable(file, plan);
    return {
      agentId: definition.agentId,
      file: workspaceRelative(workspace, file),
      planSha256: plan.planSha256,
      before: plan.baseline.counts,
      after: Object.fromEntries(SOURCES.map((source) => [source, plan.targets[source].length]))
    };
  });
  return { ok: true, command: "refresh", plans: output };
}

export function dryRunPlans(options) {
  const workspace = resolveWorkspace(options.workspace);
  const planDir = resolveWorkspaceInput(workspace, options.planDir, "plan-dir");
  const definitions = discoverDatabasePairFiles(workspace);
  const plans = readExactAgentDocuments(planDir, ".plan.json", definitions, SIGNATURE_FIELDS.plan);
  for (const plan of plans.values()) validatePlanShape(plan, { verifySignature: true });
  const artifactFiles = collectPlanArtifactFiles(workspace, planDir, plans);
  const inspected = withReadOnlyDatabaseSnapshot(workspace, definitions, artifactFiles, (snapshotWorkspace) => {
    const snapshotDefinitions = discoverDatabasePairs(snapshotWorkspace);
    assertDefinitionSetsEqual(definitions, snapshotDefinitions, "DRY_RUN_DATABASE_SET_MISMATCH");
    const snapshotPlanDir = safeWorkspaceChild(snapshotWorkspace, workspaceRelative(workspace, planDir));
    const snapshotPlans = readExactAgentDocuments(
      snapshotPlanDir,
      ".plan.json",
      snapshotDefinitions,
      SIGNATURE_FIELDS.plan
    );
    validatePlanSetArtifacts(snapshotWorkspace, snapshotPlans);
    return snapshotDefinitions.map((definition) => inspectBoundPlan(
      snapshotWorkspace,
      definition,
      snapshotPlans.get(definition.agentId)
    ));
  });
  return {
    ok: true,
    command: "dry-run",
    workspace: ".",
    agents: inspected.map(publicPlanInspection),
    planSetSha256: canonicalSha256(inspected.map((entry) => ({
      agentId: entry.plan.agentId,
      planSha256: entry.plan.planSha256,
      replacementSha256: entry.replacementSha256
    })))
  };
}

function inspectAgentMemory(workspace, definition) {
  const databasePath = path.join(workspace, definition.application);
  const database = openMigrationDatabase(databasePath, { readOnly: true });
  try {
    assertTable(database, "memory_records", definition.agentId);
    const rows = readMemoryRows(database);
    const stableKeys = new Set();
    const exportedRows = rows.map((row) => {
      const parsed = parseDataJson(row, definition.agentId);
      const effective = effectiveDataFromParsed(parsed);
      const effectiveId = normalizeText(effective.id ?? row.recordId);
      if (!effectiveId) {
        throw migrationError("MEMORY_EFFECTIVE_ID_MISSING", `${definition.agentId}: row ${row.rowId} 缺少稳定 effectiveId`);
      }
      const stableKey = memoryStableKey(row.source, effectiveId, effective);
      if (stableKeys.has(stableKey)) {
        throw migrationError("MEMORY_STABLE_KEY_DUPLICATE", `${definition.agentId}: stableKey 重复 ${stableKey}`);
      }
      stableKeys.add(stableKey);
      return {
        rowId: row.rowId,
        source: row.source,
        position: row.position,
        recordId: row.recordId,
        effectiveId,
        wrapper: isWrapperParsed(parsed),
        effectiveData: canonicalize(effective),
        stableKey
      };
    });
    const counts = countBySource(exportedRows);
    const sourceSha256 = rawSourceDigests(rows);
    const stableSourceSha256 = stableSourceDigests(exportedRows);
    return {
      agentId: definition.agentId,
      database: definition.application,
      queueDatabase: definition.queue,
      counts,
      sourceSha256,
      stableSourceSha256,
      stableSha256: canonicalSha256(exportedRows.map(stableRowProjection)),
      rows: exportedRows
    };
  } finally {
    database.close();
  }
}

function bindProposalToCurrentRows(proposal, inspection, artifacts) {
  const rowsByStableKey = uniqueStableKeyMap(inspection.rows, proposal.agentId);
  const inputsByStableKey = uniqueStableKeyMap(proposal.inputs, proposal.agentId);
  const currentKeys = [...rowsByStableKey.keys()].sort();
  const proposalKeys = [...inputsByStableKey.keys()].sort();
  if (stableJson(currentKeys) !== stableJson(proposalKeys)) {
    const added = currentKeys.filter((key) => !inputsByStableKey.has(key));
    const deleted = proposalKeys.filter((key) => !rowsByStableKey.has(key));
    throw migrationError("PROPOSAL_BASELINE_DRIFT", `${proposal.agentId}: 当前记忆集合已变化，必须重新 export/generate`, {
      added,
      deleted
    });
  }
  if (inspection.stableSha256 !== proposal.sourceStableSha256) {
    throw migrationError("PROPOSAL_BASELINE_DRIFT", `${proposal.agentId}: 当前稳定内容摘要与 proposal 不一致`);
  }

  const actionByStableKey = new Map();
  for (const action of proposal.rowActions) {
    if (!rowsByStableKey.has(action.stableKey)) {
      throw migrationError("PROPOSAL_ACTION_UNKNOWN", `${proposal.agentId}: action 引用了未知 stableKey`);
    }
    if (actionByStableKey.has(action.stableKey)) {
      throw migrationError("PROPOSAL_ACTION_DUPLICATE", `${proposal.agentId}: stableKey 重复出现在 actions`);
    }
    actionByStableKey.set(action.stableKey, action);
  }
  if (actionByStableKey.size !== rowsByStableKey.size) {
    throw migrationError("PROPOSAL_COVERAGE_INCOMPLETE", `${proposal.agentId}: proposal 未覆盖全部记忆`);
  }

  const targets = Object.fromEntries(SOURCES.map((source) => [source, []]));
  const targetsById = Object.fromEntries(SOURCES.map((source) => [source, new Map()]));
  for (const source of SOURCES) {
    for (const target of proposal.targets[source]) {
      const sourceRows = target.sourceStableKeys.map((stableKey) => rowsByStableKey.get(stableKey));
      if (sourceRows.some((row) => !row)) {
        throw migrationError("PROPOSAL_TARGET_UNKNOWN", `${proposal.agentId}: ${target.id} 含未知 stableKey`);
      }
      if (sourceRows.some((row) => row.source !== source)) {
        throw migrationError("PROPOSAL_TARGET_CROSS_SOURCE", `${proposal.agentId}: ${target.id} 跨 source 合并`);
      }
      if (sourceRows.every((row) => row.wrapper)) {
        throw migrationError("PROPOSAL_WRAPPER_ONLY_TARGET", `${proposal.agentId}: ${target.id} 只有 wrapper 证据，禁止提升`);
      }
      const baseRow = rowsByStableKey.get(target.baseStableKey);
      if (!baseRow || !target.sourceStableKeys.includes(target.baseStableKey)) {
        throw migrationError("PROPOSAL_BASE_INVALID", `${proposal.agentId}: ${target.id} baseStableKey 无效`);
      }
      if (baseRow.source !== source || target.id !== baseRow.effectiveId) {
        throw migrationError("PROPOSAL_BASE_ID_UNSTABLE", `${proposal.agentId}: ${target.id} 必须沿用 base stable ID`);
      }
      if (source === "user_profile") validateProfileEvidence(proposal.agentId, target.id, baseRow, sourceRows);
      if (targetsById[source].has(target.id)) {
        throw migrationError("PROPOSAL_TARGET_DUPLICATE", `${proposal.agentId}: ${source}/${target.id} 重复`);
      }
      const bound = {
        id: target.id,
        source,
        baseRowId: baseRow.rowId,
        baseStableKey: target.baseStableKey,
        sourceRowIds: sourceRows.map((row) => row.rowId),
        sourceStableKeys: [...target.sourceStableKeys],
        targetFact: normalizeText(target.targetFact),
        metadataPatch: canonicalize(target.metadataPatch ?? emptyMetadataPatch()),
        originalSummary: normalizeText(target.originalSummary)
      };
      targets[source].push(bound);
      targetsById[source].set(target.id, bound);
    }
  }

  const rowActions = proposal.rowActions.map((action) => {
    const row = rowsByStableKey.get(action.stableKey);
    const target = action.action === "delete"
      ? null
      : targetsById[action.source].get(normalizeText(action.targetId));
    if (action.action !== "delete" && !target) {
      throw migrationError("PROPOSAL_ACTION_TARGET_MISSING", `${proposal.agentId}: ${action.stableKey} targetId 不存在`);
    }
    if (action.source !== row.source) {
      throw migrationError("PROPOSAL_ACTION_SOURCE_MISMATCH", `${proposal.agentId}: ${action.stableKey} source 不一致`);
    }
    return {
      source: row.source,
      rowId: row.rowId,
      stableKey: row.stableKey,
      recordId: row.recordId,
      effectiveId: row.effectiveId,
      originalSummary: normalizeText(action.originalSummary),
      action: action.action,
      targetId: target?.id ?? null,
      reason: normalizeText(action.reason)
    };
  });
  validateDuplicateEffectiveIdGroups(proposal.agentId, inspection.rows, targets, rowActions);
  validateActionTargetMapping(proposal.agentId, targets, rowActions);

  const unsignedPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    migrationId: MIGRATION_ID,
    generatedAt: new Date().toISOString(),
    agentId: proposal.agentId,
    database: inspection.database,
    queueDatabase: inspection.queueDatabase,
    sourceExport: proposal.sourceExport,
    sourceExportSha256: proposal.sourceExportSha256,
    sourceProposal: artifacts.sourceProposal,
    proposalSha256: proposal.proposalSha256,
    baseline: {
      counts: inspection.counts,
      sourceSha256: inspection.sourceSha256,
      stableSourceSha256: inspection.stableSourceSha256,
      stableSha256: inspection.stableSha256
    },
    targets,
    rowActions,
    unresolved: []
  };
  validateBoundCoverage(unsignedPlan, inspection.rows);
  const replacements = buildReplacements(unsignedPlan, inspection.rows, unsignedPlan.generatedAt);
  validateReplacements(unsignedPlan.agentId, replacements);
  unsignedPlan.replacements = replacements;
  unsignedPlan.replacementSha256 = canonicalSha256(replacements);
  return signDocument(unsignedPlan, SIGNATURE_FIELDS.plan);
}

function inspectBoundPlan(workspace, definition, plan) {
  validatePlanShape(plan, { verifySignature: true });
  if (plan.agentId !== definition.agentId
    || plan.database !== definition.application
    || plan.queueDatabase !== definition.queue) {
    throw migrationError("PLAN_DATABASE_MISMATCH", `${definition.agentId}: plan 与当前数据库集合不一致`);
  }
  const current = inspectAgentMemory(workspace, definition);
  validatePlanBaseline(plan, current);
  validateBoundCoverage(plan, current.rows);
  const replacements = buildReplacements(plan, current.rows, plan.generatedAt);
  validateReplacements(plan.agentId, replacements);
  if (canonicalSha256(replacements) !== plan.replacementSha256
    || stableJson(canonicalize(replacements)) !== stableJson(canonicalize(plan.replacements))) {
    throw migrationError("PLAN_REPLACEMENT_SIGNATURE_MISMATCH", `${plan.agentId}: replacement 机械重建结果不一致`);
  }
  return {
    definition,
    plan,
    current,
    replacements,
    replacementSha256: canonicalSha256(replacements),
    protected: inspectProtectedDatabaseState(workspace, definition)
  };
}

function validateExport(snapshot) {
  if (snapshot?.schemaVersion !== EXPORT_SCHEMA_VERSION || snapshot?.migrationId !== MIGRATION_ID) {
    throw migrationError("EXPORT_SCHEMA_INVALID", "export schema 或 migrationId 无效");
  }
  assertExactObjectKeys(snapshot, EXPORT_KEYS, "EXPORT_SHAPE_INVALID", "export");
  assertNoAbsoluteArtifactPaths(snapshot, "export");
  if (snapshot.workspaceLayout !== "business-v1" || !Number.isFinite(Date.parse(snapshot.generatedAt))) {
    throw migrationError("EXPORT_SHAPE_INVALID", "export workspaceLayout 或 generatedAt 无效");
  }
  assertSha256(snapshot.exportSha256, "EXPORT_SHAPE_INVALID", "exportSha256");
  if (!Array.isArray(snapshot.agents) || snapshot.agents.length === 0) {
    throw migrationError("EXPORT_AGENT_SET_EMPTY", "export 未包含 Agent");
  }
  const agentIds = new Set();
  for (const agent of snapshot.agents) {
    assertExactObjectKeys(agent, EXPORT_AGENT_KEYS, "EXPORT_AGENT_INVALID", "export.agents[]");
    validateAgentId(agent.agentId);
    if (agentIds.has(agent.agentId)) throw migrationError("EXPORT_AGENT_DUPLICATE", `export Agent 重复：${agent.agentId}`);
    agentIds.add(agent.agentId);
    assertRelativeDatabasePath(agent.database, "sunabot.sqlite");
    assertRelativeDatabasePath(agent.queueDatabase, "session-queue.sqlite");
    if (!Array.isArray(agent.rows)) throw migrationError("EXPORT_ROWS_INVALID", `${agent.agentId}: rows 无效`);
    assertExactObjectKeys(agent.counts, SOURCES, "EXPORT_AGENT_INVALID", `${agent.agentId}: counts`);
    assertExactObjectKeys(agent.sourceSha256, SOURCES, "EXPORT_AGENT_INVALID", `${agent.agentId}: sourceSha256`);
    assertExactObjectKeys(agent.stableSourceSha256, SOURCES, "EXPORT_AGENT_INVALID", `${agent.agentId}: stableSourceSha256`);
    for (const row of agent.rows) {
      assertExactObjectKeys(row, EXPORT_ROW_KEYS, "EXPORT_ROW_INVALID", `${agent.agentId}: row`);
      if (!Number.isInteger(row.rowId)
        || !Number.isInteger(row.position)
        || !SOURCES.includes(row.source)
        || !normalizeText(row.effectiveId)
        || !normalizeText(row.stableKey)
        || typeof row.wrapper !== "boolean"
        || !row.effectiveData
        || typeof row.effectiveData !== "object"
        || Array.isArray(row.effectiveData)) {
        throw migrationError("EXPORT_ROW_INVALID", `${agent.agentId}: row 字段类型无效`);
      }
    }
    const stable = uniqueStableKeyMap(agent.rows, agent.agentId);
    if (stable.size !== agent.rows.length) throw migrationError("MEMORY_STABLE_KEY_DUPLICATE", `${agent.agentId}: stableKey 重复`);
    if (canonicalSha256(agent.rows.map(stableRowProjection)) !== agent.stableSha256) {
      throw migrationError("EXPORT_STABLE_SHA_MISMATCH", `${agent.agentId}: stableSha256 不匹配`);
    }
  }
}

function proposalInputsFromExportAgent(agent) {
  return agent.rows.map((row) => ({
    stableKey: row.stableKey,
    source: row.source,
    effectiveId: row.effectiveId,
    wrapper: row.wrapper,
    originalSummary: summarizeFact(row.effectiveData)
  }));
}

function validateProposalExportBinding(workspace, proposal, cache = new Map()) {
  const relative = assertRelativeJsonArtifactPath(proposal.sourceExport, "sourceExport");
  const exportFile = resolveWorkspaceInput(workspace, relative, "sourceExport");
  let snapshot = cache.get(exportFile);
  if (!snapshot) {
    snapshot = readSignedJson(exportFile, SIGNATURE_FIELDS.export);
    validateExport(snapshot);
    cache.set(exportFile, snapshot);
  }
  if (snapshot.exportSha256 !== proposal.sourceExportSha256) {
    throw migrationError("PROPOSAL_EXPORT_BINDING_MISMATCH", `${proposal.agentId}: sourceExportSha256 与实际 signed export 不一致`);
  }
  const agent = snapshot.agents.find((candidate) => candidate.agentId === proposal.agentId);
  if (!agent
    || agent.database !== proposal.database
    || agent.stableSha256 !== proposal.sourceStableSha256
    || stableJson(proposalInputsFromExportAgent(agent)) !== stableJson(proposal.inputs)) {
    throw migrationError("PROPOSAL_EXPORT_BINDING_MISMATCH", `${proposal.agentId}: proposal 与 signed export Agent 基线不一致`);
  }
  return snapshot;
}

function validatePlanArtifactBinding(workspace, plan) {
  validatePlanShape(plan, { verifySignature: true });
  const proposalFile = resolveWorkspaceInput(
    workspace,
    assertRelativeJsonArtifactPath(plan.sourceProposal, "sourceProposal"),
    "sourceProposal"
  );
  const proposal = readSignedJson(proposalFile, SIGNATURE_FIELDS.proposal);
  validateProposalShape(proposal, { allowUnresolved: false, verifySignature: true });
  validateProposalExportBinding(workspace, proposal);
  if (proposal.agentId !== plan.agentId
    || proposal.database !== plan.database
    || proposal.proposalSha256 !== plan.proposalSha256
    || proposal.sourceExport !== plan.sourceExport
    || proposal.sourceExportSha256 !== plan.sourceExportSha256) {
    throw migrationError("PLAN_ARTIFACT_BINDING_MISMATCH", `${plan.agentId}: plan 与 signed proposal/export 绑定不一致`);
  }
}

function validatePlanSetArtifacts(workspace, plans) {
  for (const plan of plans.values()) validatePlanArtifactBinding(workspace, plan);
}

function collectProposalArtifactFiles(workspace, proposalDir, proposals) {
  const files = new Set(listNamedJson(proposalDir, ".proposal.json"));
  for (const proposal of proposals.values()) {
    const exportFile = resolveWorkspaceInput(
      workspace,
      assertRelativeJsonArtifactPath(proposal.sourceExport, "sourceExport"),
      "sourceExport"
    );
    files.add(exportFile);
  }
  return [...files].sort();
}

function collectPlanArtifactFiles(workspace, planDir, plans) {
  const files = new Set(listNamedJson(planDir, ".plan.json"));
  for (const plan of plans.values()) {
    validatePlanShape(plan, { verifySignature: true });
    files.add(resolveWorkspaceInput(
      workspace,
      assertRelativeJsonArtifactPath(plan.sourceProposal, "sourceProposal"),
      "sourceProposal"
    ));
    files.add(resolveWorkspaceInput(
      workspace,
      assertRelativeJsonArtifactPath(plan.sourceExport, "sourceExport"),
      "sourceExport"
    ));
  }
  return [...files].sort();
}

function validateProposalShape(proposal, options) {
  if (options.verifySignature) verifyDocumentSignature(proposal, SIGNATURE_FIELDS.proposal);
  if (proposal?.schemaVersion !== PROPOSAL_SCHEMA_VERSION || proposal?.migrationId !== MIGRATION_ID) {
    throw migrationError("PROPOSAL_SCHEMA_INVALID", "proposal schema 或 migrationId 无效");
  }
  assertAllowedObjectKeys(proposal, PROPOSAL_KEYS, "PROPOSAL_SHAPE_INVALID", "proposal");
  assertNoAbsoluteArtifactPaths(proposal, "proposal");
  validateAgentId(proposal.agentId);
  assertRelativeDatabasePath(proposal.database, "sunabot.sqlite");
  assertRelativeJsonArtifactPath(proposal.sourceExport, "sourceExport");
  assertSha256(proposal.sourceExportSha256, "PROPOSAL_EXPORT_BINDING_INVALID", "sourceExportSha256");
  assertAllowedObjectKeys(
    proposal.generator,
    new Set(["kind", "providerCalled", "model"]),
    "PROPOSAL_GENERATOR_INVALID",
    `${proposal.agentId}: generator`
  );
  if (!Array.isArray(proposal.inputs) || !Array.isArray(proposal.rowActions) || !Array.isArray(proposal.unresolved)) {
    throw migrationError("PROPOSAL_SHAPE_INVALID", `${proposal.agentId}: inputs/rowActions/unresolved 无效`);
  }
  assertAllowedObjectKeys(
    proposal.targets,
    new Set(SOURCES),
    "PROPOSAL_TARGETS_INVALID",
    `${proposal.agentId}: targets`
  );
  for (const input of proposal.inputs) {
    assertAllowedObjectKeys(
      input,
      new Set(["stableKey", "source", "effectiveId", "wrapper", "originalSummary"]),
      "PROPOSAL_INPUT_INVALID",
      `${proposal.agentId}: input`
    );
  }
  const inputs = uniqueStableKeyMap(proposal.inputs, proposal.agentId);
  if (!options.allowUnresolved && proposal.unresolved.length > 0) {
    throw migrationError("PROPOSAL_UNRESOLVED", `${proposal.agentId}: 仍有 ${proposal.unresolved.length} 个未解决项`);
  }
  for (const source of SOURCES) {
    if (!Array.isArray(proposal.targets?.[source])) {
      throw migrationError("PROPOSAL_TARGETS_INVALID", `${proposal.agentId}: 缺少 targets.${source}`);
    }
    for (const target of proposal.targets[source]) validateProposalTarget(proposal.agentId, source, target, inputs);
  }
  for (const action of proposal.rowActions) {
    assertAllowedObjectKeys(
      action,
      new Set(["stableKey", "source", "effectiveId", "action", "targetId", "originalSummary", "reason"]),
      "PROPOSAL_ACTION_INVALID",
      `${proposal.agentId}: rowAction`
    );
    if (!inputs.has(action.stableKey)) throw migrationError("PROPOSAL_ACTION_UNKNOWN", `${proposal.agentId}: action stableKey 未知`);
    if (action.source !== inputs.get(action.stableKey).source) {
      throw migrationError("PROPOSAL_ACTION_SOURCE_MISMATCH", `${proposal.agentId}: action source 不一致`);
    }
    if (!options.allowUnresolved && !ACTIONS.has(action.action)) {
      throw migrationError("PROPOSAL_ACTION_INVALID", `${proposal.agentId}: action 必须为 keep/merge/delete`);
    }
    if (action.action === "delete" && action.targetId != null) {
      throw migrationError("PROPOSAL_DELETE_TARGET_INVALID", `${proposal.agentId}: delete 不能设置 targetId`);
    }
    if (!normalizeText(action.originalSummary) || !normalizeText(action.reason)) {
      throw migrationError("PROPOSAL_ACTION_AUDIT_MISSING", `${proposal.agentId}: action 缺少摘要或理由`);
    }
  }
}

function validateProposalTarget(agentId, source, target, inputs) {
  assertAllowedObjectKeys(
    target,
    new Set(["id", "source", "baseStableKey", "sourceStableKeys", "targetFact", "metadataPatch", "originalSummary"]),
    "PROPOSAL_TARGET_INVALID",
    `${agentId}: targets.${source}`
  );
  if (!target || target.source !== source || !normalizeText(target.id)) {
    throw migrationError("PROPOSAL_TARGET_INVALID", `${agentId}: targets.${source} 包含无效项`);
  }
  if (!normalizeText(target.baseStableKey)
    || !Array.isArray(target.sourceStableKeys)
    || target.sourceStableKeys.length === 0
    || new Set(target.sourceStableKeys).size !== target.sourceStableKeys.length) {
    throw migrationError("PROPOSAL_TARGET_EVIDENCE_INVALID", `${agentId}: ${target.id} 稳定证据无效`);
  }
  for (const stableKey of target.sourceStableKeys) {
    const input = inputs.get(stableKey);
    if (!input || input.source !== source) {
      throw migrationError("PROPOSAL_TARGET_EVIDENCE_INVALID", `${agentId}: ${target.id} 稳定证据不存在或跨 source`);
    }
  }
  if (!target.sourceStableKeys.includes(target.baseStableKey)) {
    throw migrationError("PROPOSAL_BASE_INVALID", `${agentId}: ${target.id} baseStableKey 未包含在证据中`);
  }
  if (!normalizeText(target.targetFact) || !normalizeText(target.originalSummary)) {
    throw migrationError("PROPOSAL_TARGET_TEXT_MISSING", `${agentId}: ${target.id} 缺少目标正文或原文摘要`);
  }
  validateMetadataPatch(agentId, target.id, target.metadataPatch);
}

function validatePlanShape(plan, options) {
  if (options.verifySignature) verifyDocumentSignature(plan, SIGNATURE_FIELDS.plan);
  if (plan?.schemaVersion !== PLAN_SCHEMA_VERSION || plan?.migrationId !== MIGRATION_ID) {
    throw migrationError("PLAN_SCHEMA_INVALID", "plan schema 或 migrationId 无效");
  }
  assertAllowedObjectKeys(plan, PLAN_KEYS, "PLAN_SHAPE_INVALID", "plan");
  assertNoAbsoluteArtifactPaths(plan, "plan");
  validateAgentId(plan.agentId);
  assertRelativeDatabasePath(plan.database, "sunabot.sqlite");
  assertRelativeDatabasePath(plan.queueDatabase, "session-queue.sqlite");
  assertRelativeJsonArtifactPath(plan.sourceExport, "sourceExport");
  assertRelativeJsonArtifactPath(plan.sourceProposal, "sourceProposal");
  assertSha256(plan.sourceExportSha256, "PLAN_ARTIFACT_BINDING_INVALID", "sourceExportSha256");
  assertSha256(plan.proposalSha256, "PLAN_ARTIFACT_BINDING_INVALID", "proposalSha256");
  assertAllowedObjectKeys(
    plan.baseline,
    new Set(["counts", "sourceSha256", "stableSourceSha256", "stableSha256"]),
    "PLAN_BASELINE_INVALID",
    `${plan.agentId}: baseline`
  );
  if (!plan.baseline?.counts || !plan.baseline?.sourceSha256 || !plan.baseline?.stableSourceSha256) {
    throw migrationError("PLAN_BASELINE_INVALID", `${plan.agentId}: baseline 无效`);
  }
  if (!Array.isArray(plan.rowActions) || !Array.isArray(plan.unresolved) || plan.unresolved.length > 0) {
    throw migrationError("PLAN_SHAPE_INVALID", `${plan.agentId}: rowActions/unresolved 无效`);
  }
  if (!plan.replacements || !normalizeText(plan.replacementSha256)) {
    throw migrationError("PLAN_REPLACEMENTS_MISSING", `${plan.agentId}: 缺少签名 replacement`);
  }
  for (const source of SOURCES) {
    if (!Array.isArray(plan.replacements[source])) {
      throw migrationError("PLAN_REPLACEMENTS_MISSING", `${plan.agentId}: replacements.${source} 无效`);
    }
  }
  if (canonicalSha256(plan.replacements) !== plan.replacementSha256) {
    throw migrationError("PLAN_REPLACEMENT_SIGNATURE_MISMATCH", `${plan.agentId}: replacementSha256 不匹配`);
  }
  for (const source of SOURCES) {
    if (!Array.isArray(plan.targets?.[source])) throw migrationError("PLAN_TARGETS_INVALID", `${plan.agentId}: targets.${source} 无效`);
    for (const target of plan.targets[source]) {
      assertAllowedObjectKeys(
        target,
        new Set([
          "id", "source", "baseRowId", "baseStableKey", "sourceRowIds", "sourceStableKeys",
          "targetFact", "metadataPatch", "originalSummary"
        ]),
        "PLAN_TARGET_INVALID",
        `${plan.agentId}: targets.${source}`
      );
      if (target.source !== source
        || !Number.isInteger(target.baseRowId)
        || !Array.isArray(target.sourceRowIds)
        || !Array.isArray(target.sourceStableKeys)
        || target.sourceRowIds.length !== target.sourceStableKeys.length
        || target.sourceRowIds.length === 0) {
        throw migrationError("PLAN_TARGET_INVALID", `${plan.agentId}: ${target.id ?? "unknown"} 绑定无效`);
      }
      validateMetadataPatch(plan.agentId, target.id, target.metadataPatch);
    }
  }
  for (const action of plan.rowActions) {
    assertAllowedObjectKeys(
      action,
      new Set([
        "source", "rowId", "stableKey", "recordId", "effectiveId", "originalSummary",
        "action", "targetId", "reason"
      ]),
      "PLAN_ACTION_INVALID",
      `${plan.agentId}: rowAction`
    );
  }
}

function validatePlanBaseline(plan, current) {
  for (const source of SOURCES) {
    if (Number(plan.baseline.counts[source]) !== current.counts[source]
      || plan.baseline.sourceSha256[source] !== current.sourceSha256[source]
      || plan.baseline.stableSourceSha256[source] !== current.stableSourceSha256[source]) {
      throw migrationError("PLAN_BASELINE_DRIFT", `${plan.agentId}: ${source} 基线已漂移，零写入失败关闭`);
    }
  }
  if (plan.baseline.stableSha256 !== current.stableSha256) {
    throw migrationError("PLAN_BASELINE_DRIFT", `${plan.agentId}: stableSha256 已漂移`);
  }
}

function validateBoundCoverage(plan, rows) {
  const rowsById = new Map(rows.map((row) => [row.rowId, row]));
  const rowsByStableKey = uniqueStableKeyMap(rows, plan.agentId);
  const actionRows = new Set();
  const targetMaps = Object.fromEntries(SOURCES.map((source) => [source, new Map()]));
  for (const source of SOURCES) {
    for (const target of plan.targets[source]) {
      if (targetMaps[source].has(target.id)) throw migrationError("PLAN_TARGET_DUPLICATE", `${plan.agentId}: ${source}/${target.id} 重复`);
      targetMaps[source].set(target.id, target);
      const evidenceRows = target.sourceRowIds.map((rowId, index) => {
        const row = rowsById.get(rowId);
        if (!row || row.stableKey !== target.sourceStableKeys[index] || row.source !== source) {
          throw migrationError("PLAN_TARGET_BINDING_STALE", `${plan.agentId}: ${target.id} rowId/stableKey 绑定已失效`);
        }
        return row;
      });
      if (!target.sourceRowIds.includes(target.baseRowId)) throw migrationError("PLAN_BASE_INVALID", `${plan.agentId}: ${target.id} baseRowId 无效`);
      if (evidenceRows.every((row) => row.wrapper)) {
        throw migrationError("PLAN_WRAPPER_ONLY_TARGET", `${plan.agentId}: ${target.id} 只有 wrapper 证据`);
      }
      const base = rowsById.get(target.baseRowId);
      if (!base || base.effectiveId !== target.id || base.stableKey !== target.baseStableKey) {
        throw migrationError("PLAN_BASE_ID_UNSTABLE", `${plan.agentId}: ${target.id} 未沿用稳定 base ID`);
      }
      if (source === "user_profile") validateProfileEvidence(plan.agentId, target.id, base, evidenceRows);
    }
  }
  for (const action of plan.rowActions) {
    const row = rowsById.get(action.rowId);
    if (!row || row.stableKey !== action.stableKey) {
      throw migrationError("PLAN_ACTION_BINDING_STALE", `${plan.agentId}: rowAction ${action.rowId} 已失效`);
    }
    if (actionRows.has(action.rowId)) throw migrationError("PLAN_ACTION_DUPLICATE", `${plan.agentId}: rowId ${action.rowId} 重复`);
    actionRows.add(action.rowId);
    if (row.source !== action.source
      || normalizeNullable(row.recordId) !== normalizeNullable(action.recordId)
      || row.effectiveId !== action.effectiveId) {
      throw migrationError("PLAN_ACTION_BINDING_STALE", `${plan.agentId}: rowAction ${action.rowId} 内容不一致`);
    }
    if (!ACTIONS.has(action.action)) throw migrationError("PLAN_ACTION_INVALID", `${plan.agentId}: action 无效`);
    if (action.action !== "delete" && !targetMaps[action.source].has(action.targetId)) {
      throw migrationError("PLAN_ACTION_TARGET_MISSING", `${plan.agentId}: targetId 不存在`);
    }
  }
  if (actionRows.size !== rows.length || rowsByStableKey.size !== rows.length) {
    throw migrationError("PLAN_COVERAGE_INCOMPLETE", `${plan.agentId}: rowActions 未完整覆盖当前 memory_records`);
  }
  validateDuplicateEffectiveIdGroups(plan.agentId, rows, plan.targets, plan.rowActions);
  validateActionTargetMapping(plan.agentId, plan.targets, plan.rowActions);
}

function validateDuplicateEffectiveIdGroups(agentId, rows, targets, actions) {
  const rowsByStableKey = uniqueStableKeyMap(rows, agentId);
  const actionsByStableKey = new Map(actions.map((action) => [action.stableKey, action]));
  const groups = new Map();
  for (const row of rows) {
    const identity = `${row.source}\u0000${row.effectiveId}`;
    const group = groups.get(identity) ?? [];
    group.push(row);
    groups.set(identity, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const source = group[0].source;
    const stableKeys = new Set(group.map((row) => row.stableKey));
    const groupTargets = targets[source].filter((target) => (
      target.sourceStableKeys.some((stableKey) => stableKeys.has(stableKey))
    ));
    if (groupTargets.length !== 1) {
      throw migrationError(
        "DUPLICATE_EFFECTIVE_ID_TARGET_INVALID",
        `${agentId}: ${source}/${group[0].effectiveId} 的重复 stableKey 必须归并为唯一 target`
      );
    }
    const [target] = groupTargets;
    if ([...stableKeys].some((stableKey) => !target.sourceStableKeys.includes(stableKey))) {
      throw migrationError(
        "DUPLICATE_EFFECTIVE_ID_COVERAGE_INCOMPLETE",
        `${agentId}: ${source}/${group[0].effectiveId} 的唯一 target 未覆盖全部 stableKey`
      );
    }
    const base = rowsByStableKey.get(target.baseStableKey);
    if (!base || !stableKeys.has(base.stableKey) || base.wrapper) {
      throw migrationError(
        "DUPLICATE_EFFECTIVE_ID_BASE_INVALID",
        `${agentId}: ${source}/${group[0].effectiveId} 必须选择 direct/non-wrapper 记录作为 base`
      );
    }
    for (const row of group) {
      const action = actionsByStableKey.get(row.stableKey);
      const expectedAction = row.stableKey === base.stableKey ? "keep" : "merge";
      if (!action || action.action !== expectedAction || action.targetId !== target.id) {
        throw migrationError(
          "DUPLICATE_EFFECTIVE_ID_ACTION_INVALID",
          `${agentId}: ${source}/${group[0].effectiveId} 的 base 必须 keep，其余记录必须 merge 到唯一 target`
        );
      }
    }
  }
}

function validateActionTargetMapping(agentId, targets, actions) {
  for (const source of SOURCES) {
    for (const target of targets[source]) {
      const declared = [...target.sourceStableKeys].sort();
      const mapped = actions
        .filter((action) => action.source === source && action.targetId === target.id)
        .map((action) => action.stableKey)
        .sort();
      if (stableJson(declared) !== stableJson(mapped)) {
        throw migrationError("TARGET_ACTION_COVERAGE_MISMATCH", `${agentId}: ${target.id} 证据与 action 映射不一致`);
      }
    }
  }
}

function buildReplacements(plan, rows, timestamp) {
  const rowsById = new Map(rows.map((row) => [row.rowId, row]));
  const idMaps = Object.fromEntries(SOURCES.map((source) => [source, new Map()]));
  for (const action of plan.rowActions) {
    if (action.action === "delete") continue;
    idMaps[action.source].set(action.effectiveId, action.targetId);
    if (action.recordId) idMaps[action.source].set(action.recordId, action.targetId);
  }
  const replacements = Object.fromEntries(SOURCES.map((source) => [source, []]));
  const targetIds = Object.fromEntries(SOURCES.map((source) => [source, new Set(plan.targets[source].map((target) => target.id))]));
  for (const source of SOURCES) {
    for (const target of plan.targets[source]) {
      const evidence = target.sourceRowIds.map((rowId) => rowsById.get(rowId));
      const base = rowsById.get(target.baseRowId);
      const data = structuredClone(base.effectiveData);
      validatePatchedReferences(plan.agentId, target, idMaps, targetIds);
      mergeControlledMetadata(
        data,
        evidence.map((row) => row.effectiveData),
        `${plan.agentId}: ${source}/${target.id}`
      );
      applyMetadataPatch(data, target.metadataPatch ?? emptyMetadataPatch(), base.effectiveData);
      data.id = target.id;
      data.fact = normalizeText(target.targetFact);
      if (source === "user_profile") data.value = data.fact;
      for (const field of ["text", "content", "summary", "memory"]) {
        if (Object.hasOwn(data, field)) data[field] = data.fact;
      }
      data.updatedAt = timestamp;
      delete data.recordId;
      delete data.position;
      delete data.data;
      if (source === "working" && data.longTermId) {
        const mapped = idMaps.long_term.get(String(data.longTermId))
          ?? (targetIds.long_term.has(String(data.longTermId)) ? String(data.longTermId) : null);
        if (mapped) data.longTermId = mapped;
        else delete data.longTermId;
      }
      if (source === "long_term" && Array.isArray(data.sourceWorkingMemoryIds)) {
        data.sourceWorkingMemoryIds = unique(data.sourceWorkingMemoryIds
          .map((id) => idMaps.working.get(String(id))
            ?? (targetIds.working.has(String(id)) ? String(id) : null))
          .filter(Boolean));
        if (!data.sourceWorkingMemoryIds.length) delete data.sourceWorkingMemoryIds;
      }
      if (source !== "user_profile") {
        const userIds = normalizeUserIdsStrict(data.userIds ?? data.userId, `${plan.agentId}: ${source}/${target.id}`);
        data.userIds = userIds;
        if (userIds.length === 1) data.userId = userIds[0];
        else delete data.userId;
        data.eventFingerprint = computeEventFingerprint(data.fact, userIds, data.occurredAt, data.occurredEndAt);
        const eventKey = computeEventKey(data.eventType, data.subjectKey, userIds);
        if (eventKey) data.eventKey = eventKey;
        else delete data.eventKey;
      }
      validateEvidenceMemoryIdentities(
        plan.agentId,
        source,
        target,
        data,
        base.effectiveData,
        evidence.map((row) => row.effectiveData)
      );
      assertImmutableMetadata(plan.agentId, target.id, source, base.effectiveData, data);
      replacements[source].push(canonicalize(data));
    }
  }
  return replacements;
}

function validateReplacements(agentId, replacements) {
  for (const source of SOURCES) {
    const records = replacements[source];
    const limit = TARGET_LIMITS[source];
    if (records.length < limit.min || records.length > limit.max) {
      throw migrationError("TARGET_COUNT_INVALID", `${agentId}: ${source} 目标数量 ${records.length} 超出 ${limit.min}-${limit.max}`);
    }
    const ids = new Set();
    for (const record of records) {
      const id = normalizeText(record.id);
      if (!id || ids.has(id)) throw migrationError("TARGET_ID_DUPLICATE", `${agentId}: ${source} id 缺失或重复`);
      ids.add(id);
      validateMemoryFact(agentId, source, record);
    }
  }
  const longTermIds = new Set(replacements.long_term.map((record) => String(record.id)));
  for (const record of replacements.working) {
    if (record.longTermId && !longTermIds.has(String(record.longTermId))) {
      throw migrationError("TARGET_REFERENCE_DANGLING", `${agentId}: working/${record.id} longTermId 悬空`);
    }
  }
  const profileUsers = new Map();
  for (const record of replacements.user_profile) {
    const userId = normalizeText(record.userId);
    if (!userId) throw migrationError("PROFILE_USER_ID_MISSING", `${agentId}: profile/${record.id} 缺少 userId`);
    const count = (profileUsers.get(userId) ?? 0) + 1;
    profileUsers.set(userId, count);
    if (count > 1) throw migrationError("PROFILE_USER_COUNT_INVALID", `${agentId}: ${userId} 只能保留 1 条画像`);
  }
}

function validateMemoryFact(agentId, source, record) {
  const fact = normalizeText(record.fact ?? record.value);
  const maximumLength = source === "user_profile" ? 300 : 360;
  if (!fact || fact.length > maximumLength) throw migrationError("TARGET_FACT_LENGTH_INVALID", `${agentId}: ${source}/${record.id} 正文为空或过长`);
  if (!/^(?:我|I\b)/i.test(fact)) throw migrationError("TARGET_FIRST_PERSON_MISSING", `${agentId}: ${source}/${record.id} 未用第一人称开头`);
  if (/(?:我(?:还|仍|仍然|依然|一直|始终|清楚地)?记得|我(?:回想|回忆)(?:起|起来)?|我(?:想起|忆起)|(?:在)?我(?:的)?印象(?:里|中)|我有印象|印象(?:里|中)我|\bI\s+(?:(?:still|clearly)\s+)?(?:remember|recall)\b)/iu.test(fact)) {
    throw migrationError("TARGET_RECALL_PHRASE_FORBIDDEN", `${agentId}: ${source}/${record.id} 正文禁止使用回忆提示语`);
  }
  const roleProse = stripQuotedSpeech(fact);
  if (!roleCognitionPrefix(roleProse)) {
    throw migrationError("TARGET_COGNITION_MISSING", `${agentId}: ${source}/${record.id} 缺少认知或感知`);
  }
  if (!/(?:^|[。！？，；,.!?;\s])(?:我(?:也)?(?:(?:感到|感觉)(?:很|有些|有点)?(?:开心|安心|欣慰|不安|难过|好奇|警惕|亲近|感激|满意|遗憾|温暖)|(?:很|有些|有点)(?:喜欢|开心|安心|担心|在意|欣慰|不安|难过|期待|好奇|警惕|亲近|敬佩|感激|厌恶|反感|偏爱|满意|遗憾|温暖|介意|重视)|喜欢|担心|在意|期待|敬佩|感激|厌恶|反感|偏爱|愿意|乐意|介意|重视)|I\s+(?:feel|am|like|love|worry|care|hope|appreciate|dislike|prefer|respect)\b)/i.test(roleProse)) {
    throw migrationError("TARGET_EMOTION_MISSING", `${agentId}: ${source}/${record.id} 缺少情绪或态度`);
  }
  if (/^\s*(?:[-*#]|\d+[.)、])\s/m.test(fact)
    || /(?:事实|情绪|认知|相关用户|用户画像|工作记忆|长期记忆)[:：]/.test(fact)) {
    throw migrationError("TARGET_FORMATTED_PROSE", `${agentId}: ${source}/${record.id} 使用了列表或字段标签`);
  }
  const context = `${agentId}: ${source}/${record.id}`;
  const userName = normalizeRequiredUserName(record.userName, context);
  const userIds = source === "user_profile"
    ? [normalizeProfileUserId(record.userId, context).normalized]
    : normalizeUserIdsStrict(record.userIds ?? record.userId, context);
  if (userIds.length === 0) {
    throw migrationError("TARGET_USER_IDS_MISSING", `${context} 缺少有效 QQ userIds`);
  }
  if (hasAmbiguousUserFirstPersonSubject(fact, userIds, userName)) {
    throw migrationError("TARGET_PERSPECTIVE_INVALID", `${context} 必须写成当前角色的第一人称认知`);
  }
  if (!fact.includes(userName)) {
    throw migrationError("TARGET_USER_NAME_NOT_NATURAL", `${context} 未自然写入昵称 ${userName}`);
  }
  for (const userId of userIds) {
    if (!naturalMemoryIdentityPattern(userId).test(fact)) {
      throw migrationError("TARGET_USER_ID_NOT_NATURAL", `${context} 未以昵称（QQ ${userId}）自然写入身份`);
    }
  }
  if (!userIds.some((userId) => hasNaturalMemoryIdentity(fact, userId, userName))) {
    throw migrationError("TARGET_USER_NAME_NOT_NATURAL", `${context} 昵称 ${userName} 未与任何相关 QQ 对应出现`);
  }
  if (source === "user_profile" && !roleProfilePerspectivePattern(userName, userIds[0]).test(fact)) {
    throw migrationError("TARGET_PROFILE_PERSPECTIVE_INVALID", `${context} 必须写成当前角色对该用户的第一人称认知`);
  }
}

function validateEvidenceMemoryIdentities(agentId, source, target, data, baseData, evidenceRows) {
  const context = `${agentId}: ${source}/${target.id}`;
  const trustedNames = new Map();
  for (const [index, evidence] of evidenceRows.entries()) {
    const evidenceContext = `${context} evidence ${index + 1}`;
    const ids = source === "user_profile"
      ? [normalizeProfileUserId(evidence.userId, evidenceContext).normalized]
      : normalizeUserIdsStrict(evidence.userIds ?? evidence.userId, evidenceContext);
    const explicitPrimary = source !== "user_profile" && evidence.userId != null
      ? normalizeUserIdsStrict(evidence.userId, evidenceContext)[0]
      : ids[0];
    const name = normalizeText(evidence.userName);
    if (!explicitPrimary || !name) continue;
    const trustedName = normalizeRequiredUserName(name, evidenceContext);
    const names = trustedNames.get(explicitPrimary) ?? new Set();
    names.add(trustedName);
    trustedNames.set(explicitPrimary, names);
  }

  const finalUserIds = source === "user_profile"
    ? [normalizeProfileUserId(data.userId, context).normalized]
    : normalizeUserIdsStrict(data.userIds ?? data.userId, context);
  const finalUserIdSet = new Set(finalUserIds);
  if (naturalMemoryIdentityMarkerUserIds(data.fact).some((userId) => !finalUserIdSet.has(userId))) {
    throw migrationError("TARGET_USER_ID_EVIDENCE_MISMATCH", `${context} 正文包含未列入 finalUserIds 的 QQ 身份`);
  }
  const baseIds = source === "user_profile"
    ? [normalizeProfileUserId(baseData.userId, `${context} base`).normalized]
    : normalizeUserIdsStrict(baseData.userIds ?? baseData.userId, `${context} base`);
  const basePrimaryId = source !== "user_profile" && baseData.userId != null
    ? normalizeUserIdsStrict(baseData.userId, `${context} base`)[0]
    : baseIds[0];
  const finalUserName = normalizeRequiredUserName(data.userName, context);
  const explicitRepairName = normalizeText(target.metadataPatch?.set?.userName);
  if (basePrimaryId) {
    const baseNames = trustedNames.get(basePrimaryId);
    if (baseNames?.size) {
      if (!baseNames.has(finalUserName)) {
        throw migrationError("TARGET_USER_NAME_EVIDENCE_MISMATCH", `${context} userName 未绑定 base evidence 的主 QQ`);
      }
    } else if (!explicitRepairName || explicitRepairName !== finalUserName) {
      throw migrationError("TARGET_USER_NAME_EVIDENCE_MISSING", `${context} 缺少受签 metadataPatch.userName 修复`);
    } else {
      trustedNames.set(basePrimaryId, new Set([finalUserName]));
    }
  }
  for (const userId of finalUserIds) {
    const names = trustedNames.get(userId);
    if (!names?.size) {
      throw migrationError("TARGET_USER_NAME_EVIDENCE_MISSING", `${context} QQ ${userId} 缺少受信昵称证据`);
    }
    if (!hasOnlyTrustedNaturalMemoryIdentities(data.fact, userId, [...names])) {
      throw migrationError("TARGET_USER_NAME_EVIDENCE_MISMATCH", `${context} QQ ${userId} 未与受信昵称成对出现`);
    }
  }
}

function validateProfileEvidence(agentId, targetId, baseRow, evidenceRows) {
  const base = normalizeProfileUserId(baseRow.effectiveData.userId, `${agentId}: ${targetId} base`);
  for (const row of evidenceRows) {
    const candidate = normalizeProfileUserId(row.effectiveData.userId, `${agentId}: ${targetId} evidence`);
    if (candidate.normalized !== base.normalized || candidate.type !== base.type) {
      throw migrationError(
        "PROFILE_EVIDENCE_USER_MISMATCH",
        `${agentId}: ${targetId} 禁止跨 userId 或跨字符串/数字类型合并画像`
      );
    }
  }
}

function validateMetadataPatch(agentId, targetId, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw migrationError("METADATA_PATCH_INVALID", `${agentId}: ${targetId} metadataPatch 无效`);
  }
  assertExactObjectKeys(patch, METADATA_PATCH_KEYS, "METADATA_PATCH_INVALID", `${agentId}: ${targetId} metadataPatch`);
  const set = patch.set ?? {};
  const remove = patch.remove ?? [];
  const preserve = patch.preserveFromBase ?? [];
  if (!set || typeof set !== "object" || Array.isArray(set)
    || !Array.isArray(remove)
    || !Array.isArray(preserve)) {
    throw migrationError("METADATA_PATCH_INVALID", `${agentId}: ${targetId} metadataPatch 结构无效`);
  }
  for (const field of [...Object.keys(set), ...remove]) {
    if (!MUTABLE_METADATA_FIELDS.has(field)) {
      throw migrationError("METADATA_PATCH_FIELD_FORBIDDEN", `${agentId}: ${targetId} 禁止修改 metadata 字段 ${field}`);
    }
  }
  if (remove.includes("userName")) {
    throw migrationError("METADATA_PATCH_VALUE_INVALID", `${agentId}: ${targetId} 禁止删除 userName`);
  }
  for (const field of preserve) {
    if (typeof field !== "string"
      || MUTABLE_METADATA_FIELDS.has(field)
      || DERIVED_EVENT_TIME_FIELDS.has(field)) {
      throw migrationError("METADATA_PATCH_PRESERVE_INVALID", `${agentId}: ${targetId} preserveFromBase 字段无效`);
    }
  }
  for (const [field, value] of Object.entries(set)) {
    if (field === "userName") {
      normalizeRequiredUserName(value, `${agentId}: ${targetId} metadataPatch.userName`);
    } else if (field === "userIds") {
      if (!Array.isArray(value) || value.length === 0) {
        throw migrationError("METADATA_PATCH_VALUE_INVALID", `${agentId}: ${targetId} userIds 必须是非空 QQ 数组`);
      }
      normalizeUserIdsStrict(value, `${agentId}: ${targetId} metadataPatch.userIds`);
    } else if (["sourceWorkingMemoryIds", "sourceCandidateIds"].includes(field)) {
      if (!Array.isArray(value)
        || value.length === 0
        || value.some((item) => typeof item !== "string" || !item.trim())) {
        throw migrationError("METADATA_PATCH_VALUE_INVALID", `${agentId}: ${targetId} ${field} 必须是非空 string 数组`);
      }
    } else if (field === "longTermId") {
      if (value !== null && (typeof value !== "string" || !value.trim())) {
        throw migrationError("METADATA_PATCH_VALUE_INVALID", `${agentId}: ${targetId} longTermId 必须是 null 或非空 string`);
      }
    } else if (field === "eventFingerprint") {
      if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw migrationError("METADATA_PATCH_VALUE_INVALID", `${agentId}: ${targetId} eventFingerprint 格式无效`);
      }
    } else if (field === "eventKey") {
      if (typeof value !== "string" || !/^v1:sha256:[a-f0-9]{64}$/.test(value)) {
        throw migrationError("METADATA_PATCH_VALUE_INVALID", `${agentId}: ${targetId} eventKey 格式无效`);
      }
    }
  }
}

function validatePatchedReferences(agentId, target, idMaps, targetIds) {
  const set = target.metadataPatch?.set ?? {};
  if (set.longTermId != null) {
    const id = String(set.longTermId);
    if (!idMaps.long_term.has(id) && !targetIds.long_term.has(id)) {
      throw migrationError("METADATA_REFERENCE_DANGLING", `${agentId}: ${target.id} longTermId 引用不存在`);
    }
  }
  if (Array.isArray(set.sourceWorkingMemoryIds)) {
    for (const value of set.sourceWorkingMemoryIds) {
      const id = String(value);
      if (!idMaps.working.has(id) && !targetIds.working.has(id)) {
        throw migrationError("METADATA_REFERENCE_DANGLING", `${agentId}: ${target.id} sourceWorkingMemoryIds 引用不存在`);
      }
    }
  }
}

function mergeControlledMetadata(target, sources, context) {
  for (const field of ["userIds", "sourceWorkingMemoryIds", "sourceCandidateIds"]) {
    const values = field === "userIds"
      ? unique(sources.flatMap((source) => [
        ...(Array.isArray(source.userIds) ? source.userIds : []),
        ...(source.userId == null ? [] : [source.userId])
      ].map(String)))
      : unique(sources.flatMap((source) => Array.isArray(source[field]) ? source[field].map(String) : []));
    if (values.length) target[field] = values;
  }
  mergeControlledEventTimeRange(target, sources, context);
}

function mergeControlledEventTimeRange(target, sources, context) {
  const ranges = sources.flatMap((source, index) => {
    const rawStart = normalizeText(source.occurredAt);
    const rawEnd = normalizeText(source.occurredEndAt);
    if (!rawStart && !rawEnd) return [];
    const start = normalizeIso(rawStart);
    const end = normalizeIso(rawEnd);
    if (!start || (rawEnd && !end)) {
      throw migrationError("TARGET_TIME_INVALID", `${context} evidence ${index + 1} 含无效事件时间`);
    }
    if (end && Date.parse(end) < Date.parse(start)) {
      throw migrationError("TARGET_TIME_INVALID", `${context} evidence ${index + 1} 的结束时间早于开始时间`);
    }
    return [{ start, end }];
  });
  if (!ranges.length) return;

  const starts = ranges.map((range) => range.start).sort();
  const endpoints = ranges.map((range) => range.end || range.start).sort();
  const earliest = starts[0];
  const latest = endpoints.at(-1);
  target.occurredAt = earliest;
  if (ranges.length > 1 || ranges.some((range) => range.end)) {
    target.occurredEndAt = latest;
  }
}

function applyMetadataPatch(data, patch, baseData) {
  validateMetadataPatch("unknown-agent", String(data.id ?? "unknown"), patch);
  for (const field of patch.preserveFromBase ?? []) {
    if (Object.hasOwn(baseData, field)) data[field] = structuredClone(baseData[field]);
    else delete data[field];
  }
  for (const field of patch.remove ?? []) delete data[field];
  Object.assign(data, structuredClone(patch.set ?? {}));
}

function assertImmutableMetadata(agentId, targetId, source, base, output) {
  for (const field of IMMUTABLE_METADATA_FIELDS) {
    if (field === "userId" && source !== "user_profile") continue;
    if (stableJson(canonicalize(base[field])) !== stableJson(canonicalize(output[field]))) {
      throw migrationError("IMMUTABLE_METADATA_CHANGED", `${agentId}: ${targetId} 稳定 metadata ${field} 被修改`);
    }
  }
}

function discoverDatabasePairFiles(workspace) {
  const definitions = [];
  const defaultData = path.join(workspace, "business", "data");
  const defaultApplication = path.join(defaultData, "sunabot.sqlite");
  const defaultQueue = path.join(defaultData, "session-queue.sqlite");
  const defaultStates = [fileState(defaultApplication), fileState(defaultQueue)];
  if (defaultStates.some((state) => state !== "missing")) {
    if (defaultStates.some((state) => state !== "file")) {
      throw migrationError("DATABASE_PAIR_INCOMPLETE", "plana application/queue 数据库必须成对存在且为普通文件");
    }
    definitions.push({
      agentId: "plana",
      application: "business/data/sunabot.sqlite",
      queue: "business/data/session-queue.sqlite"
    });
  }
  const agentsRoot = path.join(workspace, "business", "agents");
  if (fileState(agentsRoot) === "directory") {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw migrationError("SYMLINK_FORBIDDEN", `Agent 目录不能是符号链接：${entry.name}`);
      if (!entry.isDirectory()) continue;
      validateAgentId(entry.name);
      const dataDirectory = path.join(agentsRoot, entry.name, "data");
      const dataDirectoryState = fileState(dataDirectory);
      if (dataDirectoryState === "missing") continue;
      if (dataDirectoryState === "symlink") {
        throw migrationError("SYMLINK_FORBIDDEN", `Agent data 目录不能是符号链接：${entry.name}/data`);
      }
      if (dataDirectoryState !== "directory") {
        throw migrationError("WORKSPACE_LAYOUT_INVALID", `${entry.name}/data 必须是目录`);
      }
      const application = path.join(dataDirectory, "sunabot.sqlite");
      const queue = path.join(dataDirectory, "session-queue.sqlite");
      const states = [fileState(application), fileState(queue)];
      if (states.every((state) => state === "missing")) continue;
      if (states.some((state) => state === "symlink")) {
        throw migrationError("SYMLINK_FORBIDDEN", `${entry.name} application/queue 数据库不能是符号链接`);
      }
      if (states.some((state) => state !== "file")) {
        throw migrationError("DATABASE_PAIR_INCOMPLETE", `${entry.name} application/queue 数据库必须成对存在且为普通文件`);
      }
      if (entry.name === "plana") {
        if (definitions.some((definition) => definition.agentId === "plana")) {
          throw migrationError("AGENT_DATABASE_DUPLICATE", "plana 不能同时使用默认与 agents/plana/data 数据库");
        }
        throw migrationError("AGENT_REGISTRY_INVALID", "Plana 数据库必须使用 business/data 默认位置");
      }
      definitions.push({
        agentId: entry.name,
        application: `business/agents/${entry.name}/data/sunabot.sqlite`,
        queue: `business/agents/${entry.name}/data/session-queue.sqlite`
      });
    }
  } else if (fileState(agentsRoot) !== "missing") {
    throw migrationError("WORKSPACE_LAYOUT_INVALID", "business/agents 必须是目录");
  }
  if (!definitions.length) throw migrationError("DATABASE_SET_EMPTY", "workspace 中没有完整 Agent 数据库对");
  const defaultDefinition = definitions.find((definition) => definition.agentId === "plana");
  if (!defaultDefinition) throw migrationError("AGENT_REGISTRY_INVALID", "缺少默认 Plana application/queue 数据库对");
  const realpaths = new Map();
  const fileIdentities = new Map();
  for (const definition of definitions) {
    for (const database of [definition.application, definition.queue]) {
      assertRelativeDatabasePath(database, database.endsWith("sunabot.sqlite") ? "sunabot.sqlite" : "session-queue.sqlite");
      const absolute = safeWorkspaceChild(workspace, database);
      assertNoSymlinkPath(workspace, absolute);
      const real = fs.realpathSync(absolute);
      if (realpaths.has(real)) {
        throw migrationError("DATABASE_REALPATH_DUPLICATE", `${database} 与 ${realpaths.get(real)} 指向同一数据库`);
      }
      realpaths.set(real, database);
      const stat = fs.statSync(absolute);
      const identity = `${stat.dev}:${stat.ino}`;
      if (fileIdentities.has(identity)) {
        throw migrationError("DATABASE_FILE_IDENTITY_DUPLICATE", `${database} 与 ${fileIdentities.get(identity)} 指向同一数据库文件`);
      }
      fileIdentities.set(identity, database);
    }
  }
  return definitions.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

function discoverDatabasePairs(workspace) {
  const definitions = discoverDatabasePairFiles(workspace);
  const defaultDefinition = definitions.find((definition) => definition.agentId === "plana");
  const registry = readAgentRegistry(safeWorkspaceChild(workspace, defaultDefinition.application));
  const discoveredIds = definitions.map((definition) => definition.agentId).sort();
  const registeredIds = [...registry].sort();
  if (stableJson(discoveredIds) !== stableJson(registeredIds)) {
    throw migrationError("AGENT_DATABASE_SET_MISMATCH", "agents 注册表与实际 application/queue 数据库对集合不一致", {
      registered: registeredIds,
      discovered: discoveredIds
    });
  }
  return definitions;
}

function withReadOnlyDatabaseSnapshot(workspace, definitions, artifactFiles, callback) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${MIGRATION_ID}-dry-run-`));
  const snapshotWorkspace = path.join(temporaryRoot, "workspace");
  const databaseSources = definitions.flatMap((definition) => [definition.application, definition.queue]).sort();
  try {
    const before = {
      databases: inspectSnapshotSourceFiles(workspace, databaseSources),
      artifacts: inspectSnapshotArtifactFiles(workspace, artifactFiles)
    };
    for (const relative of databaseSources) {
      const source = safeWorkspaceChild(workspace, relative);
      const target = path.join(snapshotWorkspace, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      const wal = `${source}-wal`;
      if (fileState(wal) === "file") fs.copyFileSync(wal, `${target}-wal`);
    }
    for (const source of artifactFiles) {
      const relative = workspaceRelative(workspace, source);
      const target = safeWorkspaceChild(snapshotWorkspace, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o400);
    }
    let result;
    let operationError;
    try {
      result = callback(snapshotWorkspace);
    } catch (error) {
      operationError = error;
    }
    const after = {
      databases: inspectSnapshotSourceFiles(workspace, databaseSources),
      artifacts: inspectSnapshotArtifactFiles(workspace, artifactFiles)
    };
    if (stableJson(before) !== stableJson(after)) {
      throw migrationError("DATABASE_SNAPSHOT_DRIFT", "临时副本执行期间数据库、sidecar 或迁移文档发生变化，零写入失败关闭");
    }
    if (operationError) throw operationError;
    return result;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function inspectSnapshotSourceFiles(workspace, databaseSources) {
  return databaseSources.flatMap((relative) => {
    const database = safeWorkspaceChild(workspace, relative);
    return [database, `${database}-wal`, `${database}-shm`, `${database}-journal`].map((file) => {
      const state = fileState(file);
      if (!new Set(["file", "missing"]).has(state)) {
        throw migrationError("DATABASE_SNAPSHOT_FILE_UNSAFE", `dry-run 数据库路径类型异常：${file}`);
      }
      if (file.endsWith("-journal") && state === "file") {
        throw migrationError("DATABASE_SNAPSHOT_BUSY", `dry-run 不接受活跃 rollback journal：${file}`);
      }
      return {
        relative: workspaceRelative(workspace, file),
        state,
        sha256: state === "file" ? sha256File(file) : null
      };
    });
  });
}

function inspectSnapshotArtifactFiles(workspace, artifactFiles) {
  return artifactFiles.map((file) => {
    if (fileState(file) !== "file" || !isInside(workspace, file)) {
      throw migrationError("ARTIFACT_PATH_INVALID", `迁移文档必须是 workspace 内普通文件：${file}`);
    }
    assertNoSymlinkPath(workspace, file);
    return {
      relative: workspaceRelative(workspace, file),
      sha256: sha256File(file)
    };
  });
}

function readAgentRegistry(applicationPath) {
  const database = openMigrationDatabase(applicationPath, { readOnly: true });
  try {
    const registryTables = new Set(database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type='table' AND name IN ('agents', 'agent_accounts')
    `).all().map((row) => String(row.name)));
    if (registryTables.size === 0) return new Set(["plana"]);
    if (!registryTables.has("agents") || !registryTables.has("agent_accounts")) {
      throw migrationError("AGENT_REGISTRY_INVALID", "Agent 注册表 schema 不完整");
    }
    const columns = new Set(database.prepare("PRAGMA table_info(agents)").all().map((column) => String(column.name)));
    if (!columns.has("id")) throw migrationError("AGENT_REGISTRY_INVALID", "agents 表缺少 id 列");
    const ids = database.prepare("SELECT id FROM agents ORDER BY id").all().map((row) => String(row.id));
    const output = new Set();
    for (const id of ids) {
      validateAgentId(id);
      if (output.has(id)) throw migrationError("AGENT_REGISTRY_INVALID", `agents 注册 ID 重复：${id}`);
      output.add(id);
    }
    return output;
  } finally {
    database.close();
  }
}

function readExactAgentDocuments(directory, suffix, definitions, signatureField) {
  const files = listNamedJson(directory, suffix);
  const expected = new Map(definitions.map((definition) => [definition.agentId, definition]));
  const documents = new Map();
  for (const file of files) {
    const name = path.basename(file, suffix);
    if (!expected.has(name)) throw migrationError("DOCUMENT_AGENT_SET_MISMATCH", `发现额外文件：${path.basename(file)}`);
    const document = readSignedJson(file, signatureField);
    if (document.agentId !== name) throw migrationError("DOCUMENT_AGENT_ID_MISMATCH", `${path.basename(file)} agentId 不一致`);
    documents.set(name, document);
  }
  const missing = [...expected.keys()].filter((agentId) => !documents.has(agentId));
  if (missing.length || documents.size !== expected.size) {
    throw migrationError("DOCUMENT_AGENT_SET_MISMATCH", `Agent 文件集合不完整，缺少：${missing.join(", ") || "无"}`);
  }
  return documents;
}

function inspectProtectedDatabaseState(workspace, definition) {
  const applicationPath = safeWorkspaceChild(workspace, definition.application);
  const queuePath = safeWorkspaceChild(workspace, definition.queue);
  return {
    applicationLogicalSha256: databaseLogicalSha256(applicationPath),
    applicationWithoutMemorySha256: databaseLogicalSha256(applicationPath, { excludeTables: memoryMutationTables() }),
    applicationFileSha256: sha256File(applicationPath),
    queueLogicalSha256: databaseLogicalSha256(queuePath),
    queueFileSha256: sha256File(queuePath)
  };
}

function databaseLogicalSha256(databasePath, options = {}) {
  const database = openMigrationDatabase(databasePath, { readOnly: true });
  try {
    return databaseLogicalSha256FromOpenDatabase(database, options);
  } finally {
    database.close();
  }
}

function databaseLogicalSha256FromOpenDatabase(database, options = {}) {
  const schema = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all().map(canonicalize);
  const tables = schema
    .filter((entry) => entry.type === "table")
    .filter((entry) => !options.excludeTables?.has(String(entry.name)));
  const data = tables.map((entry) => {
    const name = String(entry.name);
    const quoted = quoteIdentifier(name);
    const rows = database.prepare(`SELECT * FROM ${quoted}`).all().map(canonicalize);
    rows.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    return { name, rows };
  });
  const pragmas = {
    userVersion: Number(database.prepare("PRAGMA user_version").get().user_version),
    applicationId: Number(database.prepare("PRAGMA application_id").get().application_id),
    pageSize: Number(database.prepare("PRAGMA page_size").get().page_size),
    encoding: String(database.prepare("PRAGMA encoding").get().encoding),
    autoVacuum: Number(database.prepare("PRAGMA auto_vacuum").get().auto_vacuum),
    foreignKeys: Number(database.prepare("PRAGMA foreign_keys").get().foreign_keys)
  };
  const hasSequence = database.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get();
  const sqliteSequence = hasSequence
    ? database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all()
      .filter((entry) => !options.excludeTables?.has(String(entry.name)))
      .map(canonicalize)
    : [];
  return canonicalSha256({ schema, pragmas, sqliteSequence, data });
}

function readMemoryRows(database) {
  return database.prepare(`
    SELECT row_id, source, position, record_id, data_json
    FROM memory_records
    ORDER BY source, position, row_id
  `).all().map((row) => ({
    rowId: Number(row.row_id),
    source: normalizeText(row.source),
    position: Number(row.position),
    recordId: normalizeNullable(row.record_id),
    dataJson: String(row.data_json)
  })).map((row) => {
    if (!SOURCES.includes(row.source)) throw migrationError("MEMORY_SOURCE_INVALID", `memory_records source 无效：${row.source}`);
    const parsed = parseDataJson(row, "unknown-agent");
    const effectiveData = canonicalize(effectiveDataFromParsed(parsed));
    const effectiveId = normalizeText(effectiveData.id ?? row.recordId);
    return {
      ...row,
      effectiveId,
      wrapper: isWrapperParsed(parsed),
      effectiveData,
      stableKey: memoryStableKey(row.source, effectiveId, effectiveData)
    };
  });
}

function parseDataJson(row, agentId) {
  try {
    const parsed = JSON.parse(row.dataJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON object");
    return parsed;
  } catch (error) {
    throw migrationError("MEMORY_DATA_JSON_INVALID", `${agentId}: row ${row.rowId} data_json 无效：${error.message}`);
  }
}

function effectiveDataFromParsed(parsed) {
  return parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
    ? parsed.data
    : parsed;
}

function isWrapperParsed(parsed) {
  return Boolean(parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data));
}

function rawSourceDigests(rows) {
  return Object.fromEntries(SOURCES.map((source) => [source, canonicalSha256(rows
    .filter((row) => row.source === source)
    .map((row) => ({
      rowId: row.rowId,
      source: row.source,
      position: row.position,
      recordId: row.recordId,
      dataJson: row.dataJson
    }))) ]));
}

function stableSourceDigests(rows) {
  return Object.fromEntries(SOURCES.map((source) => [source, canonicalSha256(rows
    .filter((row) => row.source === source)
    .map(stableRowProjection)
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey))) ]));
}

function stableRowProjection(row) {
  return {
    stableKey: row.stableKey,
    source: row.source,
    effectiveId: row.effectiveId,
    wrapper: Boolean(row.wrapper),
    effectiveData: canonicalize(row.effectiveData)
  };
}

function memoryStableKey(source, effectiveId, effectiveData) {
  return `${source}:${effectiveId}:sha256:${canonicalSha256({ source, effectiveId, effectiveData })}`;
}

function countBySource(rows) {
  return Object.fromEntries(SOURCES.map((source) => [source, rows.filter((row) => row.source === source).length]));
}

function publicAgentBaseline(agent) {
  return {
    agentId: agent.agentId,
    database: agent.database,
    queueDatabase: agent.queueDatabase,
    counts: agent.counts,
    sourceSha256: agent.sourceSha256,
    stableSourceSha256: agent.stableSourceSha256,
    stableSha256: agent.stableSha256
  };
}

function publicPlanInspection(inspection) {
  return {
    agentId: inspection.plan.agentId,
    database: inspection.plan.database,
    queueDatabase: inspection.plan.queueDatabase,
    planSha256: inspection.plan.planSha256,
    replacementSha256: inspection.replacementSha256,
    before: inspection.plan.baseline.counts,
    after: Object.fromEntries(SOURCES.map((source) => [source, inspection.replacements[source].length])),
    actions: Object.fromEntries(SOURCES.map((source) => {
      const actions = inspection.plan.rowActions.filter((action) => action.source === source);
      return [source, {
        keep: actions.filter((action) => action.action === "keep").length,
        merge: actions.filter((action) => action.action === "merge").length,
        delete: actions.filter((action) => action.action === "delete").length
      }];
    })),
    protected: inspection.protected
  };
}

function uniqueStableKeyMap(rows, agentId) {
  const output = new Map();
  for (const row of rows) {
    const key = normalizeText(row.stableKey);
    if (!key) throw migrationError("MEMORY_STABLE_KEY_MISSING", `${agentId}: stableKey 缺失`);
    if (output.has(key)) throw migrationError("MEMORY_STABLE_KEY_DUPLICATE", `${agentId}: stableKey 重复 ${key}`);
    output.set(key, row);
  }
  return output;
}

export async function prepareMigration(options) {
  const workspace = resolveWorkspace(options.workspace);
  return withMigrationOperationLock(workspace, options, () => prepareMigrationUnlocked(options));
}

async function prepareMigrationUnlocked(options) {
  const workspace = resolveWorkspace(options.workspace);
  const intentPath = migrationIntentPath(workspace);
  const intent = readOptionalJson(intentPath);

  if (!intent) return prepareNewMigration(options, workspace, intentPath);

  verifyIntentSignature(intent);
  if (intent.state !== "awaiting-backup" && intent.state !== "prepared") {
    throw migrationError("MIGRATION_INTENT_BLOCKED", `现有 intent 状态为 ${intent.state}，禁止 prepare`);
  }
  const entries = databaseOpenPolicyEntries(workspace, intent.databases, "production", true);
  return withMigrationDatabaseOpenPolicy(entries, options.databaseOpenObserver, () => (
    prepareExistingMigration(options, workspace, intentPath, intent)
  ));
}

async function prepareNewMigration(options, workspace, intentPath) {
  if (options.backup) {
    throw migrationError(
      "QUIESCE_INTENT_REQUIRED",
      "首次 prepare 不能直接绑定备份；请先不带 --backup 写入 durable quiesce intent，再创建恢复点"
    );
  }
  await assertOffline(workspace, options.quiesced, options.portProbe, options.handleProbe);
  const inspection = dryRunPlans({ workspace, planDir: options.planDir });
  const definitions = discoverDatabasePairs(workspace);
  const planDir = resolveWorkspaceInput(workspace, options.planDir, "plan-dir");
  const plans = readExactAgentDocuments(planDir, ".plan.json", definitions, SIGNATURE_FIELDS.plan);
  const inspectedBound = buildCurrentBinding(workspace, definitions, plans, inspection);
  checkpointAndClearSidecars(workspace, definitions);
  const bound = {
    ...inspectedBound,
    databases: refreshDatabaseFileSha256(workspace, inspectedBound.databases)
  };
  assertDatabaseSidecarsAbsent(workspace, definitions);
  const intent = {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    state: "awaiting-backup",
    createdAt: new Date().toISOString(),
    workspaceLayout: "business-v1",
    planDirectory: workspaceRelative(workspace, planDir),
    planSetSha256: inspection.planSetSha256,
    agents: bound.agents,
    databases: bound.databases,
    committedAgents: [],
    failure: null,
    backup: null
  };
  intent.intentSha256 = documentSha256(intent, "intentSha256");
  writeJsonAtomicDurable(intentPath, intent);
  return {
    ok: true,
    command: "prepare",
    state: intent.state,
    intent: workspaceRelative(workspace, intentPath),
    createdAt: intent.createdAt,
    next: "创建 quiesced SQLite recovery point，再次执行 prepare 并提供 --backup"
  };
}

async function prepareExistingMigration(options, workspace, intentPath, intent) {
  const definitions = definitionsFromIntent(intent);
  await assertStoppedHandlesAndPaths(
    workspace,
    options.quiesced,
    options.portProbe,
    options.handleProbe,
    definitions
  );
  const discovered = discoverDatabasePairFiles(workspace);
  assertDefinitionSetsEqual(definitions, discovered, "PRODUCTION_DATABASE_SET_MISMATCH");
  assertBoundDatabaseFiles(workspace, definitions, intent.databases);
  const inspection = dryRunPlans({ workspace, planDir: options.planDir });
  const planDir = resolveWorkspaceInput(workspace, options.planDir, "plan-dir");
  const plans = readExactAgentDocuments(planDir, ".plan.json", definitions, SIGNATURE_FIELDS.plan);
  const currentDatabases = assertBoundDatabaseFiles(workspace, definitions, intent.databases);
  const bound = {
    agents: buildCurrentAgentBindings(definitions, plans, inspection),
    databases: currentDatabases
  };
  assertIntentBindingMatches(intent, bound, inspection);
  if (!options.backup) {
    return {
      ok: true,
      command: "prepare",
      state: intent.state,
      intent: workspaceRelative(workspace, intentPath),
      next: intent.state === "awaiting-backup" ? "提供 --backup 完成恢复点绑定" : "执行 apply"
    };
  }
  if (intent.backup) {
    const requestedBackup = resolveExistingDirectory(options.backup, "backup");
    const boundBackup = boundRecoveryPointPath(workspace, intent.backup, "intent.backup");
    if (fs.realpathSync(requestedBackup) !== fs.realpathSync(boundBackup)) {
      throw migrationError("BACKUP_BINDING_MISMATCH", "prepare 指定的恢复点与 intent 不一致");
    }
    assertDatabaseIdentityUniverse(
      workspace,
      [{ binding: intent.backup, label: "intent.backup" }],
      [workspace],
      intent.databases
    );
    await verifyBoundRecoveryPoint(workspace, intent.backup, "intent.backup", {
      databaseOpenObserver: options.databaseOpenObserver
    });
    await options.operationLockHooks?.afterBackupValidationBeforePrepareIntent?.({
      workspace,
      databasePaths: definitions.flatMap((definition) => [definition.application, definition.queue])
    });
    assertBoundDatabaseFiles(workspace, definitions, intent.databases);
    assertIntentPlanArtifacts(workspace, planDir, definitions, intent);
    assertDatabaseIdentityUniverse(
      workspace,
      [{ binding: intent.backup, label: "intent.backup" }],
      [workspace],
      intent.databases
    );
    return {
      ok: true,
      command: "prepare",
      state: intent.state,
      intent: workspaceRelative(workspace, intentPath),
      backupId: intent.backup.backupId,
      recoveryPointId: intent.backup.recoveryPointId,
      planSetSha256: intent.planSetSha256
    };
  }
  const backup = await inspectAndBindRecoveryPoint(
    workspace,
    options.backup,
    definitions,
    intent,
    options.databaseOpenObserver
  );
  assertDatabaseIdentityUniverse(
    workspace,
    [{ binding: backup, label: "prepared.backup" }],
    [workspace],
    intent.databases
  );
  await options.operationLockHooks?.afterBackupValidationBeforePrepareIntent?.({
    workspace,
    databasePaths: definitions.flatMap((definition) => [definition.application, definition.queue])
  });
  assertBoundDatabaseFiles(workspace, definitions, intent.databases);
  assertIntentPlanArtifacts(workspace, planDir, definitions, intent);
  assertDatabaseIdentityUniverse(
    workspace,
    [{ binding: backup, label: "prepared.backup" }],
    [workspace],
    intent.databases
  );
  const next = {
    ...intent,
    state: "prepared",
    preparedAt: new Date().toISOString(),
    backup,
    failure: null
  };
  next.intentSha256 = documentSha256(next, "intentSha256");
  writeJsonAtomicDurable(intentPath, next);
  return {
    ok: true,
    command: "prepare",
    state: next.state,
    intent: workspaceRelative(workspace, intentPath),
    backupId: backup.backupId,
    recoveryPointId: backup.recoveryPointId,
    planSetSha256: next.planSetSha256
  };
}

export async function applyMigration(options) {
  const workspace = resolveWorkspace(options.workspace);
  return withMigrationOperationLock(workspace, options, () => applyMigrationUnlocked(options));
}

async function applyMigrationUnlocked(options) {
  const workspace = resolveWorkspace(options.workspace);
  const intentPath = migrationIntentPath(workspace);
  let intent = readRequiredIntent(intentPath);
  if (!["prepared", "staging-restored", "staging-applying", "staged-ready"].includes(intent.state)) {
    throw migrationError("MIGRATION_INTENT_NOT_PREPARED", `intent 状态 ${intent.state} 不允许 apply`);
  }
  const stagingPolicyWorkspace = path.resolve(options.stagingWorkspace);
  const finalizedStaging = intent.state === "staged-ready";
  const policyEntries = [
    ...databaseOpenPolicyEntries(workspace, intent.databases, "production", true),
    ...databaseOpenPolicyEntries(
      stagingPolicyWorkspace,
      finalizedStaging ? intent.stagingDatabases : intent.databases,
      "staging-live",
      finalizedStaging
    )
  ];
  return withMigrationDatabaseOpenPolicy(policyEntries, options.databaseOpenObserver, async () => {
    if (finalizedStaging) {
      return resumeStagedReadyApply(options, workspace, intent);
    }
    let stagingMutationStarted = intent.state !== "prepared";
    try {
    const intentDefinitions = definitionsFromIntent(intent);
    await assertStoppedHandlesAndPaths(
      workspace,
      options.quiesced,
      options.portProbe,
      options.handleProbe,
      intentDefinitions
    );
    const definitions = discoverDatabasePairFiles(workspace);
    assertDefinitionSetsEqual(intentDefinitions, definitions, "PRODUCTION_DATABASE_SET_MISMATCH");
    assertBoundDatabaseFiles(workspace, definitions, intent.databases);
    const stagingWorkspace = path.resolve(options.stagingWorkspace);
    if (isInside(workspace, stagingWorkspace) || path.resolve(stagingWorkspace) === path.resolve(workspace)) {
      throw migrationError("STAGING_WORKSPACE_UNSAFE", "staging workspace 必须位于当前 workspace 外部");
    }
    if (intent.stagingWorkspace && path.resolve(intent.stagingWorkspace) !== stagingWorkspace) {
      throw migrationError("STAGING_WORKSPACE_MISMATCH", "staging workspace 与 intent 不一致");
    }
    const backupPath = resolveExistingDirectory(options.backup, "backup");
    const intentBackupPath = boundRecoveryPointPath(workspace, intent.backup, "intent.backup");
    if (fs.realpathSync(backupPath) !== fs.realpathSync(intentBackupPath)) {
      throw migrationError("BACKUP_BINDING_MISMATCH", "apply 指定的恢复点与 intent 不一致");
    }
    assertDatabaseIdentityUniverse(
      workspace,
      [{ binding: intent.backup, label: "intent.backup" }],
      [workspace, stagingWorkspace],
      intent.databases
    );
    await verifyBoundRecoveryPoint(workspace, intent.backup, "intent.backup", {
      liveWorkspaces: [stagingWorkspace],
      databaseOpenObserver: options.databaseOpenObserver
    });
    const planDir = resolveWorkspaceInput(workspace, options.planDir, "plan-dir");
    const plans = readExactAgentDocuments(planDir, ".plan.json", definitions, SIGNATURE_FIELDS.plan);
    validatePlanSetArtifacts(workspace, plans);
    assertIntentPlanAuthorization(intent, definitions, plans);
    const stagingState = fileState(stagingWorkspace);
    if (intent.state === "prepared") {
      stagingMutationStarted = true;
      if (stagingState === "missing") {
        assertDatabaseIdentityUniverse(
          workspace,
          [{ binding: intent.backup, label: "intent.backup" }],
          [workspace],
          intent.databases
        );
        await restoreRecoveryPoint({
          backupDirectory: backupPath,
          targetWorkspace: stagingWorkspace,
          forbiddenDatabaseFileIdentities: collectLiveDatabaseFileIdentities(
            [workspace],
            intent.databases
          ),
          databaseOpenObserver: recoveryDatabaseOpenObserver(
            options.databaseOpenObserver,
            "intent.backup"
          )
        });
      } else if (stagingState !== "directory") {
        throw migrationError("STAGING_WORKSPACE_CONFLICT", "staging workspace 路径类型异常");
      } else {
        try {
          const existingDefinitions = discoverDatabasePairs(stagingWorkspace);
          assertDefinitionSetsEqual(definitions, existingDefinitions, "STAGING_DATABASE_SET_MISMATCH");
          const existing = inspectDatabaseSet(stagingWorkspace, existingDefinitions);
          assertDatabaseBindingMatches(intent.backup.databases, existing, { logicalOnly: true });
        } catch {
          assertDatabaseIdentityUniverse(
            workspace,
            [{ binding: intent.backup, label: "intent.backup" }],
            [workspace, stagingWorkspace],
            intent.databases
          );
          await restoreRecoveryPoint({
            backupDirectory: backupPath,
            targetWorkspace: stagingWorkspace,
            forbiddenDatabaseFileIdentities: collectLiveDatabaseFileIdentities(
              [workspace, stagingWorkspace],
              intent.databases
            ),
            databaseOpenObserver: recoveryDatabaseOpenObserver(
              options.databaseOpenObserver,
              "intent.backup"
            )
          });
        }
      }
      assertDatabaseIdentityUniverse(
        workspace,
        [{ binding: intent.backup, label: "intent.backup" }],
        [workspace, stagingWorkspace],
        intent.databases
      );
      const stagedDefinitions = discoverDatabasePairs(stagingWorkspace);
      assertDefinitionSetsEqual(definitions, stagedDefinitions, "STAGING_DATABASE_SET_MISMATCH");
      const stagedBefore = inspectDatabaseSet(stagingWorkspace, stagedDefinitions);
      assertDatabaseBindingMatches(intent.backup.databases, stagedBefore, { logicalOnly: true });
      intent = updateIntent(intentPath, intent, {
        state: "staging-restored",
        stagingWorkspace,
        stagingAppliedAgents: [],
        failure: null
      });
      maybeCrash("after-staging-restore");
    }
    assertDatabaseIdentityUniverse(
      workspace,
      [{ binding: intent.backup, label: "intent.backup" }],
      [workspace, stagingWorkspace],
      intent.databases
    );
    const stagedDefinitions = discoverDatabasePairs(stagingWorkspace);
    assertDefinitionSetsEqual(definitions, stagedDefinitions, "STAGING_DATABASE_SET_MISMATCH");
    const reconciliation = reconcileStagingPlans(stagingWorkspace, stagedDefinitions, plans, intent);
    intent = updateIntent(intentPath, intent, {
      state: "staging-applying",
      stagingReconciliation: reconciliation.map(({ agentId, state }) => ({ agentId, state }))
    });
    const unknown = reconciliation.filter((entry) => entry.state === "unknown");
    if (unknown.length) {
      throw migrationError("STAGING_STATE_UNKNOWN", `staging 出现未知状态：${unknown.map((entry) => entry.agentId).join(", ")}`);
    }
    for (const entry of reconciliation) {
      if (entry.state === "after") continue;
      maybeCrash(`before-staging-commit:${entry.agentId}`);
      applyAgentTransaction(stagingWorkspace, entry.inspection);
      maybeCrash(`after-staging-commit:${entry.agentId}`);
      verifyAgentApplied(stagingWorkspace, entry.inspection);
      maybeCrash(`after-staging-verify:${entry.agentId}`);
      intent = updateIntent(intentPath, intent, {
        stagingAppliedAgents: unique([...(intent.stagingAppliedAgents ?? []), entry.agentId])
      });
      maybeCrash(`after-staging-intent:${entry.agentId}`);
    }
    const finalReconciliation = reconcileStagingPlans(stagingWorkspace, stagedDefinitions, plans, intent);
    if (finalReconciliation.some((entry) => entry.state !== "after")) {
      throw migrationError("STAGING_APPLY_INCOMPLETE", "staging 仍有未完成或未知 Agent 状态");
    }
    for (const entry of finalReconciliation) verifyAgentApplied(stagingWorkspace, entry.inspection);
    checkpointAndClearSidecars(stagingWorkspace, stagedDefinitions);
    const stagedAfterApply = inspectDatabaseSet(stagingWorkspace, stagedDefinitions);
    const changedBackupsRoot = path.join(stagingWorkspace, "backups", "sqlite-recovery");
    let changedRecovery;
    if (intent.changedRecovery) {
      assertDatabaseIdentityUniverse(
        workspace,
        [
          { binding: intent.backup, label: "intent.backup" },
          { binding: intent.changedRecovery, label: "intent.changedRecovery" }
        ],
        [workspace, stagingWorkspace],
        intent.databases
      );
      changedRecovery = await verifyBoundRecoveryPoint(workspace, intent.changedRecovery, "intent.changedRecovery", {
        liveWorkspaces: [stagingWorkspace],
        databaseOpenObserver: options.databaseOpenObserver
      });
    } else {
      const created = await createRecoveryPoint({
        workspace: stagingWorkspace,
        backupsRoot: changedBackupsRoot,
        quiesced: true,
        databaseOpenObserver: changedRecoveryCreateObserver(options.databaseOpenObserver)
      });
      changedRecovery = await verifyRecoveryPoint(created.directory, {
        forbiddenDatabaseFileIdentities: collectLiveDatabaseFileIdentities(
          [workspace, stagingWorkspace],
          intent.databases
        ),
        databaseOpenObserver: recoveryDatabaseOpenObserver(
          options.databaseOpenObserver,
          "changedRecovery.created"
        ),
        databaseInspectionExtension: migrationRecoveryInspectionExtension
      });
      changedRecovery.databases = recoveryDatabaseBindingsFromVerification(changedRecovery);
      changedRecovery.manifestSha256 = sha256File(path.join(changedRecovery.directory, "manifest.json"));
    }
    const changedRecoveryDatabases = changedRecovery.databases;
    const changedRecoveryBinding = intent.changedRecovery ?? {
      directoryAbsolute: changedRecovery.directory,
      backupId: changedRecovery.manifest.backupId,
      recoveryPointId: changedRecovery.manifest.recoveryPointId,
      createdAt: changedRecovery.manifest.createdAt,
      manifestSha256: changedRecovery.manifestSha256
        ?? sha256File(path.join(changedRecovery.directory, "manifest.json")),
      databases: changedRecoveryDatabases
    };
    assertDatabaseIdentityUniverse(
      workspace,
      [
        { binding: intent.backup, label: "intent.backup" },
        { binding: changedRecoveryBinding, label: "changedRecovery" }
      ],
      [workspace, stagingWorkspace],
      intent.databases
    );
    maybeCrash("before-final-staging-checkpoint");
    checkpointAndClearSidecars(stagingWorkspace, stagedDefinitions);
    forbidMigrationDatabaseScope("staging-live");
    await options.operationLockHooks?.afterFinalStagingCheckpoint?.({
      databasePaths: migrationDatabasePathsForScope("staging-live"),
      probeDatabaseOpen: (databasePath) => probeMigrationDatabaseOpen("staging-live", databasePath)
    });
    const stagedAfter = refreshDatabaseFileSha256(stagingWorkspace, stagedAfterApply);
    assertDatabaseSidecarsAbsent(stagingWorkspace, stagedDefinitions);
    assertDatabaseBindingMatches(stagedAfter, changedRecoveryDatabases, { logicalOnly: false });
    maybeCrash("after-final-staging-digest");
    assertBoundDatabaseFiles(workspace, definitions, intent.databases);
    const directoryBindings = buildDataDirectoryBindings(workspace, stagingWorkspace, definitions);
    preflightInstallFilesystems(directoryBindings, options.deviceProbe);
    await options.operationLockHooks?.beforeStagedReadyIntent?.({
      workspace,
      stagingWorkspace,
      databasePaths: definitions.flatMap((definition) => [definition.application, definition.queue])
    });
    assertDatabaseIdentityUniverse(
      workspace,
      [
        { binding: intent.backup, label: "intent.backup" },
        { binding: changedRecoveryBinding, label: "changedRecovery" }
      ],
      [workspace, stagingWorkspace],
      intent.databases
    );
    assertBoundDatabaseFiles(workspace, definitions, intent.databases);
    assertBoundDatabaseFiles(stagingWorkspace, definitions, stagedAfter);
    intent = updateIntent(intentPath, intent, {
      state: "staged-ready",
      stagedReadyAt: new Date().toISOString(),
      stagingWorkspace,
      stagingDatabases: stagedAfter,
      changedRecovery: changedRecoveryBinding,
      installDirectories: directoryBindings,
      installedDirectories: []
    });
    maybeCrash("after-staged-ready-intent");
    return {
      ok: true,
      command: "apply",
      state: intent.state,
      stagingWorkspace,
      changedRecoveryPoint: changedRecovery.directory,
      next: installCommand(workspace, stagingWorkspace)
    };
    } catch (error) {
      if (isRetryableQuiescenceError(error) || !stagingMutationStarted) throw error;
      const current = readRequiredIntent(intentPath);
      updateIntent(intentPath, current, {
        state: "staging-failed",
        failedAt: new Date().toISOString(),
        failure: {
          code: error?.code ?? "STAGING_APPLY_FAILED",
          message: error?.message ?? String(error)
        }
      });
      throw migrationError(
        "STAGING_APPLY_FAILED",
        `${error?.message ?? String(error)}；durable intent 已保留，Core 不得启动`,
        { intent: workspaceRelative(workspace, intentPath) }
      );
    }
  });
}

async function resumeStagedReadyApply(options, workspace, intent) {
  const definitions = definitionsFromIntent(intent);
  await assertStoppedHandlesAndPaths(
    workspace,
    options.quiesced,
    options.portProbe,
    options.handleProbe,
    definitions
  );
  const discovered = discoverDatabasePairFiles(workspace);
  assertDefinitionSetsEqual(definitions, discovered, "PRODUCTION_DATABASE_SET_MISMATCH");
  assertBoundDatabaseFiles(workspace, definitions, intent.databases);
  const backupPath = resolveExistingDirectory(options.backup, "backup");
  const intentBackupPath = boundRecoveryPointPath(workspace, intent.backup, "intent.backup");
  if (fs.realpathSync(backupPath) !== fs.realpathSync(intentBackupPath)) {
    throw migrationError("BACKUP_BINDING_MISMATCH", "apply 指定的恢复点与 intent 不一致");
  }
  const stagingWorkspace = path.resolve(options.stagingWorkspace);
  if (path.resolve(stagingWorkspace) !== path.resolve(intent.stagingWorkspace)) {
    throw migrationError("STAGING_WORKSPACE_MISMATCH", "staging workspace 与 intent 不一致");
  }
  const recoveryBindings = [
    { binding: intent.backup, label: "intent.backup" },
    { binding: intent.changedRecovery, label: "intent.changedRecovery" }
  ];
  assertJournalDatabasePaths(definitions, intent.installDirectories);
  assertInstallBindingsAnchored(workspace, stagingWorkspace, intent.installDirectories);
  assertForwardInstallHasNotStarted(workspace, stagingWorkspace, intent);
  assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
  await verifyBoundRecoveryPoint(workspace, intent.backup, "intent.backup", {
    liveWorkspaces: [stagingWorkspace],
    databaseOpenObserver: options.databaseOpenObserver
  });
  assertBoundDatabaseFiles(stagingWorkspace, definitions, intent.stagingDatabases);
  const changedRecovery = await verifyBoundRecoveryPoint(
    workspace,
    intent.changedRecovery,
    "intent.changedRecovery",
    {
      liveWorkspaces: [stagingWorkspace],
      databaseOpenObserver: options.databaseOpenObserver
    }
  );
  assertDatabaseBindingMatches(intent.stagingDatabases, changedRecovery.databases, { logicalOnly: false });
  assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
  return {
    ok: true,
    command: "apply",
    state: intent.state,
    stagingWorkspace,
    changedRecoveryPoint: changedRecovery.directory,
    next: installCommand(workspace, stagingWorkspace)
  };
}

export async function installStagedMigration(options) {
  const workspace = resolveWorkspace(options.workspace);
  return withMigrationOperationLock(workspace, options, () => installStagedMigrationUnlocked(options));
}

async function installStagedMigrationUnlocked(options) {
  const workspace = resolveWorkspace(options.workspace);
  if (!options.confirmReplace) throw migrationError("INSTALL_CONFIRMATION_REQUIRED", "install 必须显式提供 --confirm-replace");
  const intentPath = migrationIntentPath(workspace);
  let intent = readRequiredIntent(intentPath);
  const initialState = intent.state;
  const rollbackMode = ["rollback-staged", "rollback-installing"].includes(initialState);
  if (!["staged-ready", "installing", "rollback-staged", "rollback-installing"].includes(intent.state)) {
    throw migrationError("STAGING_NOT_READY", `intent 状态 ${intent.state} 不允许 install`);
  }
  const stagingWorkspaceForPolicy = path.resolve(options.stagingWorkspace);
  const policyEntries = [
    ...databaseOpenPolicyEntries(stagingWorkspaceForPolicy, intent.stagingDatabases, "staging-live", true),
    ...databaseOpenPolicyEntries(workspace, intent.stagingDatabases, "production", true)
  ];
  return withMigrationDatabaseOpenPolicy(policyEntries, options.databaseOpenObserver, async () => {
    try {
    const definitions = definitionsFromIntent(intent);
    if (!rollbackMode) {
      const planDir = resolveWorkspaceInput(workspace, intent.planDirectory, "plan-dir");
      assertIntentPlanArtifacts(workspace, planDir, definitions, intent);
    }
    await assertStoppedHandlesAndPaths(workspace, options.quiesced, options.portProbe, options.handleProbe, definitions, {
      allowMissingCurrent: true
    });
    const stagingWorkspace = resolveWorkspace(options.stagingWorkspace);
    if (path.resolve(stagingWorkspace) !== path.resolve(intent.stagingWorkspace)) {
      throw migrationError("STAGING_WORKSPACE_MISMATCH", "staging workspace 与 intent 不一致");
    }
    assertJournalDatabasePaths(definitions, intent.installDirectories);
    assertInstallBindingsAnchored(workspace, stagingWorkspace, intent.installDirectories);
    assertProductionStillBeforeOrInstalled(workspace, stagingWorkspace, intent);
    if (initialState === "staged-ready") {
      assertForwardInstallHasNotStarted(workspace, stagingWorkspace, intent);
      assertBoundDatabaseFiles(workspace, definitions, intent.databases);
    }
    if (["staged-ready", "rollback-staged"].includes(initialState)) {
      assertDatabaseSidecarsAbsent(stagingWorkspace, definitions);
      const stagingEvidence = refreshDatabaseFileSha256(stagingWorkspace, intent.stagingDatabases);
      assertDatabaseBindingMatches(intent.stagingDatabases, stagingEvidence, { logicalOnly: false });
    }
    const hasPendingDirectoryRename = intent.installDirectories.some((binding) => (
      reconcileDirectoryInstall(workspace, stagingWorkspace, binding) !== "installed"
    ));
    const recoveryBindings = rollbackMode
      ? (hasPendingDirectoryRename ? [{ binding: intent.backup, label: "intent.backup" }] : [])
      : [
          { binding: intent.backup, label: "intent.backup" },
          { binding: intent.changedRecovery, label: "intent.changedRecovery" }
        ];
    assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
    let originalRecovery = null;
    if (!rollbackMode || hasPendingDirectoryRename) {
      originalRecovery = await verifyBoundRecoveryPoint(workspace, intent.backup, "intent.backup", {
        liveWorkspaces: [stagingWorkspace],
        databaseOpenObserver: options.databaseOpenObserver
      });
    }
    if (!rollbackMode) {
      const changedRecovery = await verifyBoundRecoveryPoint(
        workspace,
        intent.changedRecovery,
        "intent.changedRecovery",
        {
          liveWorkspaces: [stagingWorkspace],
          databaseOpenObserver: options.databaseOpenObserver
        }
      );
      assertDatabaseBindingMatches(intent.stagingDatabases, changedRecovery.databases, { logicalOnly: false });
    } else if (originalRecovery) {
      assertDatabaseBindingMatches(intent.backup.databases, originalRecovery.databases, { logicalOnly: false });
    }
    preflightInstallFilesystems(intent.installDirectories, options.deviceProbe);
    if (["staged-ready", "rollback-staged"].includes(initialState)) {
      assertForwardInstallHasNotStarted(workspace, stagingWorkspace, intent);
      if (initialState === "staged-ready") {
        assertBoundDatabaseFiles(workspace, definitions, intent.databases);
      }
      assertBoundDatabaseFiles(stagingWorkspace, definitions, intent.stagingDatabases);
    }
    assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
    intent = updateIntent(intentPath, intent, {
      state: rollbackMode ? "rollback-installing" : "installing",
      installStartedAt: intent.installStartedAt ?? new Date().toISOString()
    });
    for (const binding of intent.installDirectories) {
      validateInstallBindingPaths(binding);
      let state = reconcileDirectoryInstall(workspace, stagingWorkspace, binding);
      if (state === "installed") {
        intent = persistInstalledDirectory(intentPath, intent, binding.relative);
        continue;
      }
      if (state === "unknown") {
        throw migrationError(
          "INSTALL_DIRECTORY_UNKNOWN",
          `${binding.relative} 安装状态未知 (${describeInstallDirectoryState(binding)})`
        );
      }
      if (state === "before") {
        if (binding.beforeDirectorySha256 === "missing") {
          state = "quarantined";
        } else {
          assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
          validateInstallBindingPaths(binding);
          fs.mkdirSync(path.dirname(binding.quarantineAbsolute), { recursive: true, mode: 0o700 });
          await options.operationLockHooks?.afterInstallIdentityBeforeRename?.({
            binding: structuredClone(binding),
            phase: "current-to-quarantine"
          });
          assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
          validateInstallBindingPaths(binding);
          if (reconcileDirectoryInstall(workspace, stagingWorkspace, binding) !== "before") {
            throw migrationError(
              "INSTALL_DIRECTORY_CHANGED",
              `${binding.relative} 在 current rename 最终 CAS 前发生变化`
            );
          }
          fs.renameSync(binding.currentAbsolute, binding.quarantineAbsolute);
          syncDirectory(path.dirname(binding.currentAbsolute));
          syncDirectory(path.dirname(binding.quarantineAbsolute));
          maybeCrash(`after-install-quarantine:${binding.agentId}`);
          state = reconcileDirectoryInstall(workspace, stagingWorkspace, binding);
        }
      }
      if (state === "quarantined") {
        assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
        await options.operationLockHooks?.afterInstallIdentityBeforeRename?.({
          binding: structuredClone(binding),
          phase: "staged-to-current"
        });
        assertInstallDatabaseIdentityUniverse(workspace, intent, recoveryBindings);
        validateInstallBindingPaths(binding);
        if (reconcileDirectoryInstall(workspace, stagingWorkspace, binding) !== "quarantined") {
          throw migrationError(
            "INSTALL_DIRECTORY_CHANGED",
            `${binding.relative} 在 staged rename 最终 CAS 前发生变化`
          );
        }
        fs.renameSync(binding.stagedAbsolute, binding.currentAbsolute);
        syncDirectory(path.dirname(binding.currentAbsolute));
        maybeCrash(`after-install-rename:${binding.agentId}`);
        state = reconcileDirectoryInstall(workspace, stagingWorkspace, binding);
      }
      if (state !== "installed") {
        throw migrationError(
          "INSTALL_DIRECTORY_UNKNOWN",
          `${binding.relative} 安装后状态未知 (${describeInstallDirectoryState(binding)})`
        );
      }
      intent = persistInstalledDirectory(intentPath, intent, binding.relative);
      maybeCrash(`after-install-intent:${binding.agentId}`);
    }
    maybeCrash("after-install-directories");
    assertDatabaseSidecarsAbsent(workspace, definitions);
    const after = refreshDatabaseFileSha256(workspace, intent.stagingDatabases);
    assertDatabaseBindingMatches(intent.stagingDatabases, after, { logicalOnly: false });
    if (rollbackMode) {
      assertDatabaseBindingMatches(intent.backup.databases, after, { logicalOnly: false });
      const fullVerification = originalRecovery?.databases ?? intent.backup.databases;
      const reportPath = path.join(workspace, "business", "migrations", `${MIGRATION_ID}-rollback-report.json`);
      const report = signDocument({
        schemaVersion: 1,
        migrationId: MIGRATION_ID,
        status: "rolled-back",
        completedAt: new Date().toISOString(),
        backup: intent.backup,
        databases: after,
        verification: fullVerification,
        quarantineDirectories: intent.installDirectories.map((entry) => entry.quarantineAbsolute)
      }, "reportSha256");
      writeJsonAtomicDurable(reportPath, report);
      fs.rmSync(intentPath);
      syncDirectory(path.dirname(intentPath));
      return { ok: true, command: "install", status: "rolled-back", report: workspaceRelative(workspace, reportPath) };
    }
    const reportPath = path.join(workspace, "business", "migrations", `${MIGRATION_ID}-pending-report.json`);
    const report = signDocument({
      schemaVersion: 1,
      migrationId: MIGRATION_ID,
      status: "pending-verification",
      installedAt: new Date().toISOString(),
      backup: intent.backup,
      changedRecovery: intent.changedRecovery,
      planSetSha256: intent.planSetSha256,
      agents: intent.agents,
      databasesBefore: intent.databases,
      databasesAfter: after,
      quarantineDirectories: intent.installDirectories.map((entry) => entry.quarantineAbsolute)
    }, "reportSha256");
    writeJsonAtomicDurable(reportPath, report);
    intent = updateIntent(intentPath, intent, {
      state: "verifying",
      pendingReport: workspaceRelative(workspace, reportPath),
      pendingReportSha256: report.reportSha256,
      databasesAfter: after
    });
    return {
      ok: true,
      command: "install",
      state: intent.state,
      pendingReport: workspaceRelative(workspace, reportPath),
      next: `node tooling/migrations/${MIGRATION_ID}.mjs verify --workspace ${shellQuote(workspace)} --plan-dir ${shellQuote(intent.planDirectory)} --report ${shellQuote(reportPath)} --quiesced`
    };
    } catch (error) {
      if (isRetryableQuiescenceError(error)) throw error;
      const current = readRequiredIntent(intentPath);
      const currentRollbackMode = ["rollback-staged", "rollback-installing"].includes(current.state);
      let failureState;
      if (current.state === "staged-ready") {
        failureState = "staged-ready";
      } else if (currentRollbackMode) {
        failureState = current.state;
      } else {
        failureState = "rollback-required";
      }
      updateIntent(intentPath, current, {
        state: failureState,
        failedAt: new Date().toISOString(),
        failure: { code: error?.code ?? "INSTALL_FAILED", message: error?.message ?? String(error) }
      });
      const retryableWithoutRollback = failureState === "staged-ready" || failureState === "rollback-staged";
      throw migrationError(
        retryableWithoutRollback
          ? "INSTALL_PREFLIGHT_FAILED"
          : currentRollbackMode ? "ROLLBACK_RESUME_REQUIRED" : "ROLLBACK_REQUIRED",
        `安装未完整成功：${error?.message ?? String(error)}`
      );
    }
  });
}

export async function verifyMigration(options) {
  const workspace = resolveWorkspace(options.workspace);
  return withMigrationOperationLock(workspace, options, () => verifyMigrationUnlocked(options));
}

async function verifyMigrationUnlocked(options) {
  const workspace = resolveWorkspace(options.workspace);
  const intentPath = migrationIntentPath(workspace);
  const intent = readRequiredIntent(intentPath);
  if (intent.state !== "verifying") throw migrationError("MIGRATION_INTENT_BLOCKED", `intent 状态 ${intent.state} 不允许 verify，Core 不得启动`);
  try {
    const definitions = definitionsFromIntent(intent);
    const recoveryBindings = [
      { binding: intent.backup, label: "intent.backup" },
      { binding: intent.changedRecovery, label: "intent.changedRecovery" }
    ];
    const assertIdentityGate = () => assertInstallDatabaseIdentityUniverse(
      workspace,
      intent,
      recoveryBindings
    );
    await assertOffline(
      workspace,
      options.quiesced,
      options.portProbe,
      options.handleProbe,
      definitions,
      {
        beforeDatabaseOpen: assertIdentityGate,
        databaseOpenObserver: options.databaseOpenObserver
      }
    );
    assertIdentityGate();
    const expectedReportPath = resolveWorkspaceInput(workspace, intent.pendingReport, "pending-report");
    const reportPath = options.report
      ? resolveWorkspaceInput(workspace, options.report, "report")
      : expectedReportPath;
    if (path.resolve(reportPath) !== path.resolve(expectedReportPath)) {
      throw migrationError("REPORT_PATH_MISMATCH", "待验证报告路径未与 intent 绑定");
    }
    const report = readSignedJson(reportPath, "reportSha256");
    assertPendingReportBinding(intent, report);
    const inspection = dryRunAppliedPlans({ workspace, planDir: options.planDir, report });
    await verifyBoundRecoveryPoint(workspace, report.backup, "report.backup", {
      databaseOpenObserver: options.databaseOpenObserver
    });
    await verifyBoundRecoveryPoint(workspace, report.changedRecovery, "report.changedRecovery", {
      databaseOpenObserver: options.databaseOpenObserver
    });
    assertIdentityGate();
    const finalPath = path.join(workspace, "business", "migrations", `${MIGRATION_ID}-report.json`);
    const finalReport = signDocument({
      ...report,
      status: "complete",
      completedAt: new Date().toISOString(),
      verification: inspection
    }, "reportSha256");
    writeJsonAtomicDurable(finalPath, finalReport);
    fs.rmSync(reportPath);
    syncDirectory(path.dirname(reportPath));
    fs.rmSync(intentPath);
    syncDirectory(path.dirname(intentPath));
    return {
      ok: true,
      command: "verify",
      report: workspaceRelative(workspace, finalPath),
      reportSha256: finalReport.reportSha256,
      planSetSha256: report.planSetSha256,
      agents: inspection.agents
    };
  } catch (error) {
    if (isRetryableQuiescenceError(error)) throw error;
    const current = readRequiredIntent(intentPath);
    if (current.state === "verifying") {
      updateIntent(intentPath, current, {
        state: "rollback-required",
        failedAt: new Date().toISOString(),
        failure: { code: error?.code ?? "VERIFY_FAILED", message: error?.message ?? String(error) }
      });
    } else if (current.state !== "rollback-required") {
      throw migrationError("MIGRATION_INTENT_CONFLICT", `verify 失败时 intent 已变为 ${current.state}，禁止覆盖`);
    }
    throw migrationError("ROLLBACK_REQUIRED", `完整 verify 失败：${error?.message ?? String(error)}`);
  }
}

function isRetryableQuiescenceError(error) {
  return new Set(["QUIESCENCE_REQUIRED", "CORE_STILL_RUNNING", "DATABASE_HANDLE_OPEN"]).has(error?.code);
}

function assertPendingReportBinding(intent, report) {
  if (report.migrationId !== MIGRATION_ID
    || report.status !== "pending-verification"
    || report.reportSha256 !== intent.pendingReportSha256
    || report.planSetSha256 !== intent.planSetSha256
    || stableJson(canonicalize(report.backup)) !== stableJson(canonicalize(intent.backup))
    || stableJson(canonicalize(report.changedRecovery)) !== stableJson(canonicalize(intent.changedRecovery))
    || stableJson(canonicalize(report.agents)) !== stableJson(canonicalize(intent.agents))
    || stableJson(canonicalize(report.databasesBefore)) !== stableJson(canonicalize(intent.databases))
    || stableJson(canonicalize(report.databasesAfter)) !== stableJson(canonicalize(intent.databasesAfter))) {
    throw migrationError("REPORT_INVALID", "待验证报告无效或未与 intent 绑定");
  }
}

export async function stageRollback(options) {
  const workspace = resolveWorkspace(options.workspace);
  return withMigrationOperationLock(workspace, options, () => stageRollbackUnlocked(options));
}

async function stageRollbackUnlocked(options) {
  const workspace = resolveWorkspace(options.workspace);
  const intentPath = migrationIntentPath(workspace);
  let intent = readRequiredIntent(intentPath);
  const rollbackStates = new Set([
    "prepared",
    "staging-restored",
    "staging-applying",
    "staging-failed",
    "staged-ready",
    "installing",
    "verifying",
    "rollback-required",
    "rollback-staged",
    "rollback-installing"
  ]);
  if (intent.state === "awaiting-backup" || !intent.backup) {
    throw migrationError(
      "ROLLBACK_BACKUP_REQUIRED",
      "intent 尚未绑定 original backup，不能声称可 rollback；Core 必须保持停止并人工恢复"
    );
  }
  if (!rollbackStates.has(intent.state)) {
    throw migrationError("ROLLBACK_NOT_REQUIRED", `intent 状态 ${intent.state} 不允许 rollback`);
  }
  const currentDefinitions = definitionsFromIntent(intent);
  const targetWorkspace = path.resolve(String(options.targetWorkspace ?? ""));
  if (targetWorkspace === path.resolve(workspace) || isInside(workspace, targetWorkspace)) {
    throw migrationError("ROLLBACK_STAGING_UNSAFE", "rollback staging 必须位于当前 workspace 外部的空目录");
  }
  if (fileState(targetWorkspace) === "symlink") {
    throw migrationError("SYMLINK_FORBIDDEN", "rollback staging root 不能是符号链接");
  }
  const rollbackRecoveryBindings = [{ binding: intent.backup, label: "intent.backup" }];
  const assertIdentityGate = () => assertInstallDatabaseIdentityUniverse(
    workspace,
    intent,
    rollbackRecoveryBindings,
    [workspace, targetWorkspace],
    intent.backup.databases
  );
  await assertOffline(workspace, options.quiesced, options.portProbe, options.handleProbe, currentDefinitions, {
    allowMissingCurrent: true,
    beforeDatabaseOpen: assertIdentityGate,
    databaseOpenObserver: options.databaseOpenObserver
  });
  assertIdentityGate();
  const backupPath = resolveExistingDirectory(options.backup, "backup");
  const intentBackupPath = boundRecoveryPointPath(workspace, intent.backup, "intent.backup");
  if (fs.realpathSync(backupPath) !== fs.realpathSync(intentBackupPath)) {
    throw migrationError("BACKUP_BINDING_MISMATCH", "rollback 必须使用签名 intent 绑定的原始恢复点");
  }
  const verified = await verifyBoundRecoveryPoint(workspace, intent.backup, "intent.backup", {
    liveWorkspaces: [targetWorkspace],
    databaseOpenObserver: options.databaseOpenObserver
  });
  if (intent.state !== "rollback-required") {
    intent = updateIntent(intentPath, intent, {
      state: "rollback-required",
      rollbackRequestedAt: intent.rollbackRequestedAt ?? new Date().toISOString()
    });
  }
  if (intent.installDirectories) {
    await normalizeInstallForRollbackRebuild(
      workspace,
      intent,
      assertIdentityGate,
      options.operationLockHooks
    );
  }
  const retainedQuarantineDirectories = collectRetainedQuarantineDirectories(workspace, intent);
  let restored;
  if (fileState(targetWorkspace) === "missing") {
    restored = await restoreRecoveryPoint({
      backupDirectory: backupPath,
      targetWorkspace,
      forbiddenDatabaseFileIdentities: collectLiveDatabaseFileIdentities(
        [workspace],
        intent.backup.databases
      ),
      databaseOpenObserver: rollbackRestoreDatabaseOpenObserver(options.databaseOpenObserver)
    });
  } else {
    if (fileState(targetWorkspace) !== "directory") {
      throw migrationError("ROLLBACK_STAGING_CONFLICT", "rollback staging 必须是空目录或完整的 original backup staging");
    }
    const existingDefinitions = discoverDatabasePairs(targetWorkspace);
    assertDefinitionSetsEqual(currentDefinitions, existingDefinitions, "ROLLBACK_STAGING_SET_MISMATCH");
    const existing = inspectDatabaseSet(targetWorkspace, existingDefinitions);
    assertDatabaseBindingMatches(intent.backup.databases, existing, { logicalOnly: true });
    restored = { ok: true, targetWorkspace, verification: existing };
  }
  const stagingDefinitions = discoverDatabasePairs(targetWorkspace);
  assertDefinitionSetsEqual(currentDefinitions, stagingDefinitions, "ROLLBACK_STAGING_SET_MISMATCH");
  await options.operationLockHooks?.afterRollbackRestoreBeforeCheckpoint?.({
    workspace,
    targetWorkspace
  });
  assertIdentityGate();
  checkpointAndClearSidecars(workspace, currentDefinitions, { allowMissing: true });
  checkpointAndClearSidecars(targetWorkspace, stagingDefinitions);
  const staged = inspectDatabaseSet(targetWorkspace, stagingDefinitions);
  assertDatabaseBindingMatches(intent.backup.databases, staged, { logicalOnly: true });
  checkpointAndClearSidecars(targetWorkspace, stagingDefinitions);
  const finalizedStaged = refreshDatabaseFileSha256(targetWorkspace, staged);
  assertDatabaseSidecarsAbsent(targetWorkspace, stagingDefinitions);
  assertIdentityGate();
  const rollbackBindings = buildRollbackDirectoryBindings(workspace, targetWorkspace, currentDefinitions);
  preflightInstallFilesystems(rollbackBindings, options.deviceProbe);
  intent = updateIntent(intentPath, intent, {
    state: "rollback-staged",
    rollbackStagedAt: new Date().toISOString(),
    rollbackStagingWorkspace: targetWorkspace,
    stagingWorkspace: targetWorkspace,
    stagingDatabases: finalizedStaged,
    installDirectories: rollbackBindings,
    retainedQuarantineDirectories,
    installedDirectories: [],
    failure: intent.failure
  });
  return {
    ok: true,
    command: "rollback",
    state: intent.state,
    stagingWorkspace: targetWorkspace,
    verification: restored.verification ?? staged,
    recoveryCommand: rollbackCommand(workspace, backupPath, targetWorkspace),
    finalizeCommand: installCommand(workspace, targetWorkspace)
  };
}

export async function abortMigration(options) {
  const workspace = resolveWorkspace(options.workspace);
  return withMigrationOperationLock(workspace, options, () => abortMigrationUnlocked(options));
}

async function abortMigrationUnlocked(options) {
  const workspace = resolveWorkspace(options.workspace);
  const intentPath = migrationIntentPath(workspace);
  assertNoSymlinkPath(workspace, intentPath);
  const intent = readRequiredIntent(intentPath);
  if (!PRE_INSTALL_STATES.has(intent.state)
    || (intent.committedAgents?.length ?? 0) > 0
    || (intent.installedDirectories?.length ?? 0) > 0) {
    throw migrationError("ABORT_NOT_SAFE", `intent 状态 ${intent.state} 已越过安全取消边界，必须走 rollback`);
  }
  const definitions = definitionsFromIntent(intent);
  await assertStoppedHandlesAndPaths(
    workspace,
    options.quiesced,
    options.portProbe,
    options.handleProbe,
    definitions,
    { allowMissingCurrent: true }
  );
  const currentIntent = readRequiredIntent(intentPath);
  if (currentIntent.intentSha256 !== intent.intentSha256) {
    throw migrationError("MIGRATION_INTENT_CHANGED", "abort 门禁执行期间 durable intent 已变化；未写报告或清除 intent");
  }
  const reportPath = path.join(workspace, "business", "migrations", `${MIGRATION_ID}-abort-${Date.now()}.json`);
  const report = signDocument({
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    status: "aborted",
    abortedAt: new Date().toISOString(),
    previousState: intent.state,
    intentSha256: intent.intentSha256,
    planSetSha256: intent.planSetSha256
  }, "reportSha256");
  writeJsonAtomicDurable(reportPath, report);
  await invokeOperationLockFault(options, "abort:after-report-fsync", { intentPath, reportPath });
  await options.operationLockHooks?.beforeAbortIntentDelete?.({ intentPath, intent: structuredClone(intent) });
  const intentBeforeDelete = readRequiredIntent(intentPath);
  if (intentBeforeDelete.intentSha256 !== intent.intentSha256) {
    throw migrationError("MIGRATION_INTENT_CHANGED", "abort 报告写入后 durable intent 已变化；保留 intent");
  }
  fs.rmSync(intentPath);
  syncDirectory(path.dirname(intentPath));
  return { ok: true, command: "abort", report: workspaceRelative(workspace, reportPath), reportSha256: report.reportSha256 };
}

function buildCurrentBinding(workspace, definitions, plans, dryRun) {
  return {
    agents: buildCurrentAgentBindings(definitions, plans, dryRun),
    databases: inspectDatabaseSet(workspace, definitions)
  };
}

function buildCurrentAgentBindings(definitions, plans, dryRun) {
  const dryByAgent = new Map(dryRun.agents.map((agent) => [agent.agentId, agent]));
  return definitions.map((definition) => {
    const plan = plans.get(definition.agentId);
    const inspection = dryByAgent.get(definition.agentId);
    return {
      agentId: definition.agentId,
      application: definition.application,
      queue: definition.queue,
      planSha256: plan.planSha256,
      proposalSha256: plan.proposalSha256,
      baselineSha256: canonicalSha256(plan.baseline),
      replacementSha256: inspection.replacementSha256
    };
  });
}

function assertIntentPlanArtifacts(workspace, planDir, definitions, intent) {
  const plans = readExactAgentDocuments(planDir, ".plan.json", definitions, SIGNATURE_FIELDS.plan);
  validatePlanSetArtifacts(workspace, plans);
  assertIntentPlanAuthorization(intent, definitions, plans);
}

function assertIntentPlanAuthorization(intent, definitions, plans) {
  const agents = definitions.map((definition) => {
    const plan = plans.get(definition.agentId);
    return {
      agentId: definition.agentId,
      application: definition.application,
      queue: definition.queue,
      planSha256: plan.planSha256,
      proposalSha256: plan.proposalSha256,
      baselineSha256: canonicalSha256(plan.baseline),
      replacementSha256: plan.replacementSha256
    };
  });
  const planSetSha256 = canonicalSha256(agents.map((agent) => ({
    agentId: agent.agentId,
    planSha256: agent.planSha256,
    replacementSha256: agent.replacementSha256
  })));
  if (intent.planSetSha256 !== planSetSha256
    || stableJson(intent.agents) !== stableJson(agents)) {
    throw migrationError(
      "MIGRATION_INTENT_BINDING_MISMATCH",
      "当前 plan/replacement 集合与 signed intent 不一致"
    );
  }
}

function inspectDatabaseSet(workspace, definitions) {
  return definitions.flatMap((definition) => [
    inspectDatabaseBinding(workspace, definition.agentId, "application", definition.application),
    inspectDatabaseBinding(workspace, definition.agentId, "session_queue", definition.queue)
  ]);
}

function withMigrationDatabaseOpenPolicy(entries, observer, operation) {
  const policies = new Map();
  for (const entry of entries) {
    const databasePath = path.resolve(entry.databasePath);
    if (policies.has(databasePath)) {
      throw migrationError("DATABASE_OPEN_POLICY_INVALID", `重复数据库打开策略：${databasePath}`);
    }
    policies.set(databasePath, {
      scope: entry.scope,
      forbidden: entry.forbidden === true
    });
  }
  return DATABASE_OPEN_POLICY.run({
    policies,
    observer: typeof observer === "function" ? observer : null
  }, operation);
}

function databaseOpenPolicyEntries(workspace, bindings, scope, forbidden) {
  return bindings.map((binding) => ({
    databasePath: safeWorkspaceChild(workspace, binding.source),
    scope,
    forbidden
  }));
}

function forbidMigrationDatabaseScope(scope) {
  const policy = DATABASE_OPEN_POLICY.getStore();
  if (!policy) throw migrationError("DATABASE_OPEN_POLICY_MISSING", `缺少 ${scope} 数据库打开策略`);
  for (const entry of policy.policies.values()) {
    if (entry.scope === scope) entry.forbidden = true;
  }
}

function migrationDatabasePathsForScope(scope) {
  const policy = DATABASE_OPEN_POLICY.getStore();
  if (!policy) return [];
  return [...policy.policies.entries()]
    .filter(([, entry]) => entry.scope === scope)
    .map(([databasePath]) => databasePath)
    .sort();
}

function probeMigrationDatabaseOpen(scope, databasePath) {
  const absolute = path.resolve(databasePath);
  if (!migrationDatabasePathsForScope(scope).includes(absolute)) {
    throw migrationError("DATABASE_OPEN_POLICY_INVALID", `${scope} probe 路径未绑定：${absolute}`);
  }
  const database = openMigrationDatabase(absolute, { readOnly: true });
  database.close();
}

function openMigrationDatabase(databasePath, options) {
  const absolute = path.resolve(databasePath);
  const policy = DATABASE_OPEN_POLICY.getStore();
  const entry = policy?.policies.get(absolute);
  if (entry) {
    policy.observer?.({
      databasePath: absolute,
      scope: entry.scope,
      blocked: entry.forbidden
    });
    if (entry.forbidden) {
      throw migrationError(
        "SQLITE_OPEN_FORBIDDEN",
        `${entry.scope} 数据库已进入纯文件阶段，禁止再次由 SQLite 打开：${absolute}`
      );
    }
  }
  return options === undefined
    ? new DatabaseSync(databasePath)
    : new DatabaseSync(databasePath, options);
}

function refreshDatabaseFileSha256(workspace, bindings) {
  return bindings.map((binding) => {
    const absolute = safeWorkspaceChild(workspace, binding.source);
    assertNoSymlinkPath(workspace, absolute);
    if (fileState(absolute) !== "file") {
      throw migrationError("DATABASE_PATH_INVALID", `${binding.source} 必须是非 symlink 普通文件`);
    }
    return { ...binding, fileSha256: sha256File(absolute) };
  });
}

function assertBoundDatabaseFiles(workspace, definitions, bindings) {
  const discovered = discoverDatabasePairFiles(workspace);
  assertDefinitionSetsEqual(definitions, discovered, "DATABASE_SET_MISMATCH");
  const expectedSources = definitions
    .flatMap((definition) => [definition.application, definition.queue])
    .sort();
  const boundSources = bindings.map((binding) => normalizeRelativePath(binding.source)).sort();
  if (stableJson(expectedSources) !== stableJson(boundSources)) {
    throw migrationError("DATABASE_BINDING_MISMATCH", "数据库文件集合与 signed binding 不一致");
  }
  assertDatabaseSidecarsAbsent(workspace, definitions);
  const current = refreshDatabaseFileSha256(workspace, bindings);
  assertDatabaseBindingMatches(bindings, current, { logicalOnly: false });
  return current;
}

function assertDatabaseSidecarsAbsent(workspace, definitions) {
  for (const definition of definitions) {
    for (const relative of [definition.application, definition.queue]) {
      const databasePath = safeWorkspaceChild(workspace, relative);
      for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        if (fileState(sidecar) !== "missing") {
          throw migrationError(
            "SQLITE_SIDECAR_NOT_CLEARED",
            `${workspaceRelative(workspace, sidecar)} 在纯文件摘要前必须不存在`
          );
        }
      }
    }
  }
}

function inspectDatabaseBinding(workspace, agentId, kind, relative) {
  const absolute = safeWorkspaceChild(workspace, relative);
  return {
    id: `agent:${agentId}:${kind}`,
    agentId,
    kind,
    source: relative,
    fileSha256: sha256File(absolute),
    logicalSha256: databaseLogicalSha256(absolute),
    withoutMemorySha256: kind === "application"
      ? databaseLogicalSha256(absolute, { excludeTables: memoryMutationTables() })
      : null,
    memoryBaselineSha256: kind === "application"
      ? applicationMemoryBaselineSha256(absolute)
      : null
  };
}

function applicationMemoryBaselineSha256(databasePath) {
  const database = openMigrationDatabase(databasePath, { readOnly: true });
  try {
    return applicationMemoryBaselineSha256FromOpenDatabase(database);
  } finally {
    database.close();
  }
}

function applicationMemoryBaselineSha256FromOpenDatabase(database) {
  return canonicalSha256(readMemoryRows(database).map((row) => ({
    rowId: row.rowId,
    source: row.source,
    position: row.position,
    recordId: row.recordId,
    dataJson: row.dataJson
  })));
}

async function inspectAndBindRecoveryPoint(
  workspace,
  backupInput,
  definitions,
  intent,
  databaseOpenObserver
) {
  const backupDirectory = resolveExistingDirectory(backupInput, "backup");
  const verified = await verifyRecoveryPoint(backupDirectory, {
    forbiddenDatabaseFileIdentities: collectLiveDatabaseFileIdentities(
      [workspace],
      intent.databases
    ),
    databaseOpenObserver: recoveryDatabaseOpenObserver(
      databaseOpenObserver,
      "prepared.backup"
    ),
    databaseInspectionExtension: migrationRecoveryInspectionExtension
  });
  const manifest = verified.manifest;
  if (manifest.schemaVersion !== 2) throw migrationError("BACKUP_MANIFEST_VERSION_INVALID", "恢复点必须使用 manifest v2");
  if (!(Date.parse(manifest.createdAt) >= Date.parse(intent.createdAt))) {
    throw migrationError("BACKUP_TOO_OLD", "恢复点 createdAt 必须晚于本次 durable quiesce intent");
  }
  const expectedSources = definitions.flatMap((definition) => [definition.application, definition.queue]).sort();
  const actualSources = manifest.databases.map((entry) => normalizeRelativePath(entry.source)).sort();
  if (stableJson(expectedSources) !== stableJson(actualSources)) {
    throw migrationError("BACKUP_DATABASE_SET_MISMATCH", "恢复点数据库集合与当前 Agent application/queue 集合不一致");
  }
  assertBoundDatabaseFiles(workspace, definitions, intent.databases);
  const backupDatabases = recoveryDatabaseBindingsFromVerification(verified);
  assertDatabaseBindingMatches(intent.databases, backupDatabases, { logicalOnly: true });
  const binding = {
    directory: isInside(workspace, backupDirectory) ? workspaceRelative(workspace, backupDirectory) : null,
    directoryAbsolute: backupDirectory,
    backupId: manifest.backupId,
    recoveryPointId: manifest.recoveryPointId,
    createdAt: manifest.createdAt,
    manifestSha256: sha256File(path.join(backupDirectory, "manifest.json")),
    databases: backupDatabases
  };
  return binding;
}

function boundRecoveryPointPath(workspace, binding, label) {
  if (!binding || typeof binding !== "object") {
    throw migrationError("RECOVERY_BINDING_MISSING", `${label} 缺失`);
  }
  const input = binding.directoryAbsolute
    ?? (binding.directory ? path.join(workspace, binding.directory) : null);
  if (!input) throw migrationError("RECOVERY_BINDING_MISSING", `${label} 未绑定恢复点目录`);
  return resolveExistingDirectory(input, `${label}.directory`);
}

async function verifyBoundRecoveryPoint(workspace, binding, label, options = {}) {
  const directory = boundRecoveryPointPath(workspace, binding, label);
  const liveWorkspaces = unique([workspace, ...(options.liveWorkspaces ?? [])].map((entry) => path.resolve(entry)));
  const verified = await verifyRecoveryPoint(directory, {
    forbiddenDatabaseFileIdentities: collectLiveDatabaseFileIdentities(
      liveWorkspaces,
      binding.databases
    ),
    databaseOpenObserver: recoveryDatabaseOpenObserver(options.databaseOpenObserver, label),
    databaseInspectionExtension: migrationRecoveryInspectionExtension
  });
  if (verified.manifest.schemaVersion !== 2
    || verified.manifest.backupId !== binding.backupId
    || verified.manifest.recoveryPointId !== binding.recoveryPointId) {
    throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} ID 或 manifest version 与 signed intent 不一致`);
  }
  const manifestSha256 = sha256File(path.join(verified.directory, "manifest.json"));
  if (!binding.manifestSha256 || manifestSha256 !== binding.manifestSha256) {
    throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} manifestSha256 与 signed intent 不一致`);
  }
  const databases = recoveryDatabaseBindingsFromVerification(verified);
  assertDatabaseBindingMatches(binding.databases, databases, { logicalOnly: false });
  return { ...verified, manifestSha256, databases };
}

function migrationRecoveryInspectionExtension({ database, definition }) {
  return {
    logicalSha256: databaseLogicalSha256FromOpenDatabase(database),
    withoutMemorySha256: definition.kind === "application"
      ? databaseLogicalSha256FromOpenDatabase(database, { excludeTables: memoryMutationTables() })
      : null,
    memoryBaselineSha256: definition.kind === "application"
      ? applicationMemoryBaselineSha256FromOpenDatabase(database)
      : null
  };
}

function memoryMutationTables() {
  return new Set(["memory_records", "memory_source_revisions"]);
}

function recoveryDatabaseBindingsFromVerification(verified) {
  const manifestById = new Map(verified.manifest.databases.map((entry) => [entry.id, entry]));
  return verified.inspections.map((inspection) => {
    const manifest = manifestById.get(inspection.id);
    const extension = inspection.extension;
    if (!manifest
      || !extension
      || typeof extension.logicalSha256 !== "string"
      || (inspection.kind === "application"
        && (typeof extension.withoutMemorySha256 !== "string"
          || typeof extension.memoryBaselineSha256 !== "string"))) {
      throw migrationError(
        "RECOVERY_BINDING_MISMATCH",
        `${inspection.id} 恢复数据库缺少同一 verifier 句柄生成的绑定摘要`
      );
    }
    return {
      id: inspection.id,
      agentId: inspection.agentId,
      kind: inspection.kind,
      source: normalizeRelativePath(manifest.source),
      fileSha256: manifest.sha256,
      logicalSha256: extension.logicalSha256,
      withoutMemorySha256: extension.withoutMemorySha256,
      memoryBaselineSha256: extension.memoryBaselineSha256
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function recoveryDatabaseOpenObserver(observer, recoveryBinding) {
  if (typeof observer !== "function") return undefined;
  return (event) => observer({
    ...event,
    scope: "recovery",
    blocked: false,
    recoveryBinding
  });
}

function changedRecoveryCreateObserver(observer) {
  if (typeof observer !== "function") return undefined;
  return (event) => observer({
    ...event,
    scope: String(event.phase ?? "").startsWith("source-") ? "staging-live" : "recovery",
    blocked: false,
    recoveryBinding: "changedRecovery.created"
  });
}

function rollbackRestoreDatabaseOpenObserver(observer) {
  if (typeof observer !== "function") return undefined;
  return (event) => observer({
    ...event,
    scope: ["restore-staging-verify", "restored-workspace-verify"].includes(event.phase)
      ? "rollback-staging"
      : "recovery",
    blocked: false,
    recoveryBinding: "intent.backup"
  });
}

function assertDatabaseIdentityUniverse(workspace, recoveryBindings, liveWorkspaces, liveBindings) {
  const entries = [
    ...recoveryBindings.flatMap(({ binding, label }) => (
      collectRecoveryDatabaseIdentityEntries(workspace, binding, label)
    )),
    ...collectLiveDatabaseIdentityEntries(liveWorkspaces, liveBindings)
  ];
  assertDatabaseIdentityEntriesUnique(entries);
  return entries.sort((left, right) => left.label.localeCompare(right.label));
}

function assertInstallDatabaseIdentityUniverse(
  workspace,
  intent,
  recoveryBindings,
  extraLiveWorkspaces = [],
  extraLiveBindings = intent.stagingDatabases ?? intent.databases ?? []
) {
  const retainedQuarantineDirectories = validateRetainedQuarantineDirectories(workspace, intent);
  assertNoUnsignedInstallDatabaseFiles(
    workspace,
    intent,
    extraLiveWorkspaces,
    extraLiveBindings,
    retainedQuarantineDirectories
  );
  const entries = recoveryBindings.flatMap(({ binding, label }) => (
    collectRecoveryDatabaseIdentityEntries(workspace, binding, label)
  ));
  const seenPaths = new Set();
  for (const binding of intent.installDirectories ?? []) {
    for (const [role, directory] of [
      ["current", binding.currentAbsolute],
      ["staged", binding.stagedAbsolute],
      ["quarantine", binding.quarantineAbsolute]
    ]) {
      if (fileState(directory) === "missing") continue;
      if (fileState(directory) !== "directory") {
        throw migrationError("INSTALL_DIRECTORY_UNKNOWN", `${binding.relative} ${role} 目录状态无效`);
      }
      for (const name of ["sunabot.sqlite", "session-queue.sqlite"]) {
        const databasePath = path.join(directory, name);
        if (seenPaths.has(databasePath) || fileState(databasePath) === "missing") continue;
        seenPaths.add(databasePath);
        if (fileState(databasePath) !== "file" || fs.lstatSync(databasePath).isSymbolicLink()) {
          throw migrationError("DATABASE_PATH_INVALID", `${databasePath} 必须是非 symlink 普通文件`);
        }
        const stat = fs.lstatSync(databasePath);
        if (stat.nlink !== 1) {
          throw migrationError("LIVE_DATABASE_LINK_UNSAFE", `${databasePath} 必须是独立数据库文件`);
        }
        entries.push({
          label: `install:${binding.agentId}:${role}:${name}`,
          path: databasePath,
          dev: stat.dev,
          ino: stat.ino,
          nlink: stat.nlink
        });
      }
    }
  }
  for (const retained of retainedQuarantineDirectories) {
    if (fileState(retained.quarantineAbsolute) === "missing") continue;
    for (const name of ["sunabot.sqlite", "session-queue.sqlite"]) {
      const databasePath = path.join(retained.quarantineAbsolute, name);
      if (seenPaths.has(databasePath) || fileState(databasePath) === "missing") continue;
      seenPaths.add(databasePath);
      if (fileState(databasePath) !== "file" || fs.lstatSync(databasePath).isSymbolicLink()) {
        throw migrationError("DATABASE_PATH_INVALID", `${databasePath} 必须是非 symlink 普通文件`);
      }
      const stat = fs.lstatSync(databasePath);
      if (stat.nlink !== 1) {
        throw migrationError("LIVE_DATABASE_LINK_UNSAFE", `${databasePath} 必须是独立数据库文件`);
      }
      entries.push({
        label: `install-retained:${retained.agentId}:${name}`,
        path: databasePath,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink
      });
    }
  }
  for (const entry of collectLiveDatabaseIdentityEntries(extraLiveWorkspaces, extraLiveBindings)) {
    if (seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);
    entries.push(entry);
  }
  assertDatabaseIdentityEntriesUnique(entries);
  return entries.sort((left, right) => left.label.localeCompare(right.label));
}

function assertNoUnsignedInstallDatabaseFiles(
  workspace,
  intent,
  extraLiveWorkspaces,
  extraLiveBindings,
  retainedQuarantineDirectories
) {
  const allowed = new Set();
  const workspaceRoots = new Set();
  for (const binding of intent.installDirectories ?? []) {
    for (const directory of [
      binding.currentAbsolute,
      binding.stagedAbsolute,
      binding.quarantineAbsolute
    ]) {
      for (const name of ["sunabot.sqlite", "session-queue.sqlite"]) {
        allowed.add(path.resolve(directory, name));
      }
    }
    workspaceRoots.add(rootForBoundRelative(binding.currentAbsolute, binding.relative));
    workspaceRoots.add(rootForBoundRelative(binding.stagedAbsolute, binding.relative));
  }
  for (const retained of retainedQuarantineDirectories) {
    for (const name of ["sunabot.sqlite", "session-queue.sqlite"]) {
      allowed.add(path.resolve(retained.quarantineAbsolute, name));
    }
  }
  for (const liveWorkspace of extraLiveWorkspaces) {
    const root = path.resolve(liveWorkspace);
    workspaceRoots.add(root);
    for (const binding of extraLiveBindings) {
      allowed.add(safeWorkspaceChild(root, binding.source));
    }
  }
  for (const root of workspaceRoots) {
    scanInstallDatabaseFiles(path.join(root, "business", "data"), allowed);
    scanInstallDatabaseFiles(path.join(root, "business", "agents"), allowed);
  }
  const quarantineRoot = path.join(
    workspace,
    "business",
    "migrations",
    `${MIGRATION_ID}-quarantine`
  );
  scanInstallDatabaseFiles(quarantineRoot, allowed);
  scanInstallDatabaseFiles(path.join(
    workspace,
    "business",
    "migrations",
    `${MIGRATION_ID}-rollback-quarantine`
  ), allowed);
}

function scanInstallDatabaseFiles(root, allowed) {
  const state = fileState(root);
  if (state === "missing") return;
  if (state !== "directory") {
    throw migrationError("INSTALL_DATABASE_SET_INVALID", `安装数据库扫描根类型无效：${root}`);
  }
  const pending = [path.resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw migrationError("SYMLINK_FORBIDDEN", `安装数据库扫描路径不能是符号链接：${absolute}`);
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !["sunabot.sqlite", "session-queue.sqlite"].includes(entry.name)) continue;
      if (!allowed.has(path.resolve(absolute))) {
        throw migrationError("INSTALL_DATABASE_SET_MISMATCH", `发现未授权安装数据库：${absolute}`);
      }
    }
  }
}

function assertDatabaseIdentityEntriesUnique(entries) {
  const byIdentity = new Map();
  for (const entry of entries) {
    const identity = `${entry.dev}:${entry.ino}`;
    const conflict = byIdentity.get(identity);
    if (conflict) {
      throw migrationError(
        "DATABASE_FILE_IDENTITY_ALIAS",
        `${entry.label} 与 ${conflict.label} 共用数据库文件身份`
      );
    }
    byIdentity.set(identity, entry);
  }
}

function collectRecoveryDatabaseIdentityEntries(workspace, binding, label) {
  const directory = boundRecoveryPointPath(workspace, binding, label);
  const manifestPath = path.join(directory, "manifest.json");
  assertNoSymlinkPath(directory, manifestPath);
  if (fileState(manifestPath) !== "file") {
    throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} manifest 缺失或不是普通文件`);
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  if (!binding.manifestSha256 || binding.manifestSha256 !== manifestSha256) {
    throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} manifestSha256 与 signed intent 不一致`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} manifest 不是有效 JSON：${error.message}`);
  }
  if (manifest?.schemaVersion !== 2
    || manifest.backupId !== binding.backupId
    || manifest.recoveryPointId !== binding.recoveryPointId
    || !Array.isArray(manifest.databases)
    || manifest.databases.length !== binding.databases.length) {
    throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} manifest 与 signed intent 不一致`);
  }
  const expectedBySource = new Map(binding.databases.map((entry) => [normalizeRelativePath(entry.source), entry]));
  const seenSources = new Set();
  return manifest.databases.map((entry) => {
    const source = normalizeRelativePath(entry?.source);
    const expected = expectedBySource.get(source);
    if (!expected
      || seenSources.has(source)
      || entry.id !== expected.id
      || entry.agentId !== expected.agentId
      || entry.kind !== expected.kind
      || typeof entry.file !== "string"
      || path.basename(entry.file) !== entry.file
      || !entry.file.endsWith(".sqlite")) {
      throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} 数据库 manifest 集合无效`);
    }
    seenSources.add(source);
    const databasePath = path.resolve(directory, entry.file);
    if (path.dirname(databasePath) !== path.resolve(directory)) {
      throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} 数据库路径越界`);
    }
    assertNoSymlinkPath(directory, databasePath);
    if (fileState(databasePath) !== "file") {
      throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} 恢复数据库缺失或不是普通文件`);
    }
    const stat = fs.lstatSync(databasePath);
    if (stat.nlink !== 1) {
      throw migrationError("RECOVERY_DATABASE_LINK_UNSAFE", `${label} 恢复数据库必须是独立文件`);
    }
    if (sha256File(databasePath) !== expected.fileSha256) {
      throw migrationError("RECOVERY_BINDING_MISMATCH", `${label} 恢复数据库摘要与 signed intent 不一致`);
    }
    return {
      label: `${label}:${source}`,
      path: databasePath,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink
    };
  });
}

function collectLiveDatabaseFileIdentities(liveWorkspaces, bindings) {
  return collectLiveDatabaseIdentityEntries(liveWorkspaces, bindings)
    .map((entry) => `${entry.dev}:${entry.ino}`);
}

function collectLiveDatabaseIdentityEntries(liveWorkspaces, bindings) {
  const entries = [];
  for (const liveWorkspace of unique(liveWorkspaces.map((entry) => path.resolve(entry)))) {
    for (const binding of bindings) {
      const databasePath = safeWorkspaceChild(liveWorkspace, binding.source);
      const state = fileState(databasePath);
      if (state === "missing") continue;
      assertNoSymlinkPath(liveWorkspace, databasePath);
      if (state !== "file") {
        throw migrationError("DATABASE_PATH_INVALID", `${databasePath} 必须是非 symlink 普通文件`);
      }
      const stat = fs.lstatSync(databasePath);
      if (stat.nlink !== 1) {
        throw migrationError("LIVE_DATABASE_LINK_UNSAFE", `${databasePath} 必须是独立数据库文件`);
      }
      entries.push({
        label: `live:${liveWorkspace}:${normalizeRelativePath(binding.source)}`,
        path: databasePath,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink
      });
    }
  }
  return entries;
}

function assertDatabaseBindingMatches(expected, actual, options = {}) {
  const expectedBySource = new Map(expected.map((entry) => [entry.source, entry]));
  const actualBySource = new Map(actual.map((entry) => [entry.source, entry]));
  if (expectedBySource.size !== actualBySource.size) throw migrationError("DATABASE_BINDING_MISMATCH", "数据库集合数量不一致");
  for (const [source, expectedEntry] of expectedBySource) {
    const actualEntry = actualBySource.get(source);
    if (!actualEntry
      || actualEntry.id !== expectedEntry.id
      || actualEntry.kind !== expectedEntry.kind
      || actualEntry.logicalSha256 !== expectedEntry.logicalSha256
      || actualEntry.withoutMemorySha256 !== expectedEntry.withoutMemorySha256
      || actualEntry.memoryBaselineSha256 !== expectedEntry.memoryBaselineSha256) {
      throw migrationError("DATABASE_BINDING_MISMATCH", `${source} 逻辑摘要与绑定不一致`);
    }
    if (!options.logicalOnly && actualEntry.fileSha256 !== expectedEntry.fileSha256) {
      throw migrationError("DATABASE_BINDING_MISMATCH", `${source} 源文件摘要与绑定不一致`);
    }
  }
}

function assertIntentBindingMatches(intent, bound, inspection) {
  if (intent.migrationId !== MIGRATION_ID
    || intent.planSetSha256 !== inspection.planSetSha256
    || stableJson(intent.agents) !== stableJson(bound.agents)) {
    throw migrationError("MIGRATION_INTENT_BINDING_MISMATCH", "候选、replacement 或 Agent 集合与 intent 不一致");
  }
  assertDatabaseBindingMatches(intent.databases, bound.databases, { logicalOnly: true });
}

function applyAgentTransaction(workspace, inspection) {
  const databasePath = safeWorkspaceChild(workspace, inspection.definition.application);
  const database = openMigrationDatabase(databasePath);
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const current = inspectAgentMemoryWithinOpenDatabase(database, inspection.definition);
    validatePlanBaseline(inspection.plan, current);
    validateBoundCoverage(inspection.plan, current.rows);
    const remove = database.prepare("DELETE FROM memory_records WHERE source = ?");
    const insert = database.prepare(`
      INSERT INTO memory_records(source, position, record_id, data_json)
      VALUES (?, ?, ?, json(?))
    `);
    for (const source of SOURCES) {
      remove.run(source);
      inspection.replacements[source].forEach((record, position) => {
        insert.run(source, position, String(record.id), JSON.stringify(record));
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction did not start */ }
    throw error;
  } finally {
    database.close();
  }
  syncFile(databasePath);
  syncDirectory(path.dirname(databasePath));
}

function inspectAgentMemoryWithinOpenDatabase(database, definition) {
  const rows = readMemoryRows(database);
  const exportedRows = rows.map((row) => ({
    rowId: row.rowId,
    source: row.source,
    position: row.position,
    recordId: row.recordId,
    effectiveId: row.effectiveId,
    wrapper: row.wrapper,
    effectiveData: row.effectiveData,
    stableKey: row.stableKey
  }));
  return {
    agentId: definition.agentId,
    database: definition.application,
    queueDatabase: definition.queue,
    counts: countBySource(exportedRows),
    sourceSha256: rawSourceDigests(rows),
    stableSourceSha256: stableSourceDigests(exportedRows),
    stableSha256: canonicalSha256(exportedRows.map(stableRowProjection)),
    rows: exportedRows
  };
}

function verifyAgentApplied(workspace, inspection) {
  const databasePath = safeWorkspaceChild(workspace, inspection.definition.application);
  const database = openMigrationDatabase(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (String(integrity?.integrity_check) !== "ok" || foreignKeys.length) {
      throw migrationError("SQLITE_VERIFY_FAILED", `${inspection.plan.agentId}: SQLite 提交后校验失败`);
    }
    const rows = readMemoryRows(database);
    assertRowsEqualReplacements(inspection.plan.agentId, rows, inspection.replacements);
  } finally {
    database.close();
  }
  const protectedAfter = inspectProtectedDatabaseState(workspace, inspection.definition);
  if (protectedAfter.applicationWithoutMemorySha256 !== inspection.protected.applicationWithoutMemorySha256
    || protectedAfter.queueLogicalSha256 !== inspection.protected.queueLogicalSha256) {
    throw migrationError("PROTECTED_DATA_CHANGED", `${inspection.plan.agentId}: 非 memory_records 或 queue 数据发生变化`);
  }
}

function assertRowsEqualReplacements(agentId, rows, replacements) {
  for (const source of SOURCES) {
    const actual = rows.filter((row) => row.source === source).map((row) => ({
      source: row.source,
      position: row.position,
      recordId: row.recordId,
      wrapper: row.wrapper,
      data: row.effectiveData
    }));
    const expected = replacements[source].map((record, position) => ({
      source,
      position,
      recordId: String(record.id),
      wrapper: false,
      data: canonicalize(record)
    }));
    if (stableJson(canonicalize(actual)) !== stableJson(canonicalize(expected))) {
      throw migrationError("APPLIED_RECORDS_MISMATCH", `${agentId}: ${source} 完整记录与 replacement 不一致`);
    }
  }
}

function verifyAppliedSet(workspace, detailed, intent) {
  const databases = [];
  const samples = {};
  for (const inspection of detailed) {
    verifyAgentApplied(workspace, inspection);
    const state = inspectProtectedDatabaseState(workspace, inspection.definition);
    databases.push(
      inspectDatabaseBinding(workspace, inspection.plan.agentId, "application", inspection.definition.application),
      inspectDatabaseBinding(workspace, inspection.plan.agentId, "session_queue", inspection.definition.queue)
    );
    samples[inspection.plan.agentId] = Object.fromEntries(SOURCES.map((source) => [source,
      inspection.replacements[source].slice(0, 2).map((record) => ({ id: record.id, fact: record.fact }))
    ]));
    const before = intent.databases.find((entry) => entry.source === inspection.definition.application);
    const queueBefore = intent.databases.find((entry) => entry.source === inspection.definition.queue);
    if (state.applicationWithoutMemorySha256 !== before.withoutMemorySha256
      || state.queueLogicalSha256 !== queueBefore.logicalSha256) {
      throw migrationError("PROTECTED_DATA_CHANGED", `${inspection.plan.agentId}: protected 摘要不一致`);
    }
  }
  return { databases, samples };
}

function dryRunAppliedPlans(options) {
  const workspace = resolveWorkspace(options.workspace);
  const definitions = discoverDatabasePairs(workspace);
  const planDir = resolveWorkspaceInput(workspace, options.planDir, "plan-dir");
  const plans = readExactAgentDocuments(planDir, ".plan.json", definitions, SIGNATURE_FIELDS.plan);
  validatePlanSetArtifacts(workspace, plans);
  const expectedPlanSet = canonicalSha256(definitions.map((definition) => {
    const plan = plans.get(definition.agentId);
    const reportAgent = options.report.agents.find((agent) => agent.agentId === definition.agentId);
    if (!reportAgent
      || reportAgent.planSha256 !== plan.planSha256
      || reportAgent.replacementSha256 !== plan.replacementSha256) {
      throw migrationError("REPORT_PLAN_MISMATCH", `${definition.agentId}: report/plan SHA 不一致`);
    }
    const currentRows = readCurrentRows(workspace, definition);
    validateReplacements(plan.agentId, plan.replacements);
    assertRowsEqualReplacements(plan.agentId, currentRows, plan.replacements);
    return {
      agentId: definition.agentId,
      planSha256: plan.planSha256,
      replacementSha256: plan.replacementSha256
    };
  }));
  if (expectedPlanSet !== options.report.planSetSha256) {
    throw migrationError("REPORT_PLAN_SET_MISMATCH", "report planSetSha256 不一致");
  }
  const currentDatabases = inspectDatabaseSet(workspace, definitions);
  for (const entry of currentDatabases) {
    const before = options.report.databasesBefore.find((candidate) => candidate.source === entry.source);
    const after = options.report.databasesAfter.find((candidate) => candidate.source === entry.source);
    if (!before || !after || entry.logicalSha256 !== after.logicalSha256) {
      throw migrationError("VERIFY_DATABASE_LOGICAL_SHA_MISMATCH", `${entry.source} full logical SHA 与成功报告不一致`);
    }
    if (entry.kind === "session_queue" && entry.logicalSha256 !== before.logicalSha256) {
      throw migrationError("VERIFY_QUEUE_CHANGED", `${entry.source} queue 摘要改变`);
    }
    if (entry.kind === "application" && entry.withoutMemorySha256 !== before.withoutMemorySha256) {
      throw migrationError("VERIFY_PROTECTED_CHANGED", `${entry.source} 非 memory_records 摘要改变`);
    }
  }
  return {
    agents: definitions.map((definition) => ({
      agentId: definition.agentId,
      planSha256: plans.get(definition.agentId).planSha256
    }))
  };
}

function readCurrentRows(workspace, definition) {
  const database = openMigrationDatabase(safeWorkspaceChild(workspace, definition.application), { readOnly: true });
  try { return readMemoryRows(database); } finally { database.close(); }
}

function reconcileStagingPlans(workspace, definitions, plans, intent) {
  return definitions.map((definition) => {
    const plan = plans.get(definition.agentId);
    validatePlanShape(plan, { verifySignature: true });
    const current = inspectAgentMemory(workspace, definition);
    const before = planBaselineMatches(plan, current);
    let after = false;
    try {
      validateReplacements(plan.agentId, plan.replacements);
      assertRowsEqualReplacements(plan.agentId, current.rows, plan.replacements);
      after = true;
    } catch {
      after = false;
    }
    const beforeDatabase = intent.databases.find((entry) => entry.source === definition.application);
    const protectedState = inspectProtectedDatabaseState(workspace, definition);
    if (protectedState.applicationWithoutMemorySha256 !== beforeDatabase.withoutMemorySha256) {
      return { agentId: definition.agentId, state: "unknown", plan };
    }
    const inspection = {
      definition,
      plan,
      current,
      replacements: plan.replacements,
      replacementSha256: plan.replacementSha256,
      protected: {
        applicationWithoutMemorySha256: beforeDatabase.withoutMemorySha256,
        queueLogicalSha256: intent.databases.find((entry) => entry.source === definition.queue).logicalSha256
      }
    };
    return {
      agentId: definition.agentId,
      state: before && !after ? "before" : after && !before ? "after" : "unknown",
      plan,
      inspection
    };
  });
}

function planBaselineMatches(plan, current) {
  try {
    validatePlanBaseline(plan, current);
    validateBoundCoverage(plan, current.rows);
    const rebuilt = buildReplacements(plan, current.rows, plan.generatedAt);
    return stableJson(canonicalize(rebuilt)) === stableJson(canonicalize(plan.replacements));
  } catch {
    return false;
  }
}

function buildDataDirectoryBindings(workspace, stagingWorkspace, definitions) {
  const seen = new Set();
  return definitions.map((definition) => {
    const relative = path.posix.dirname(definition.application);
    if (seen.has(relative)) throw migrationError("INSTALL_DIRECTORY_DUPLICATE", `${relative} 重复`);
    seen.add(relative);
    const currentAbsolute = safeWorkspaceChild(workspace, relative);
    const stagedAbsolute = safeWorkspaceChild(stagingWorkspace, relative);
    assertDataDirectoryContents(currentAbsolute);
    assertDataDirectoryContents(stagedAbsolute);
    const quarantineAbsolute = path.join(
      workspace,
      "business",
      "migrations",
      `${MIGRATION_ID}-quarantine`,
      definition.agentId,
      "data"
    );
    if (fileState(quarantineAbsolute) !== "missing") {
      throw migrationError("INSTALL_QUARANTINE_CONFLICT", `隔离目录已存在：${quarantineAbsolute}`);
    }
    return {
      agentId: definition.agentId,
      relative,
      currentAbsolute,
      stagedAbsolute,
      quarantineAbsolute,
      beforeDirectorySha256: directoryDigest(currentAbsolute),
      afterDirectorySha256: directoryDigest(stagedAbsolute)
    };
  });
}

function buildRollbackDirectoryBindings(workspace, stagingWorkspace, definitions) {
  const attemptId = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  return definitions.map((definition) => {
    const relative = path.posix.dirname(definition.application);
    const currentAbsolute = safeWorkspaceChild(workspace, relative);
    const stagedAbsolute = safeWorkspaceChild(stagingWorkspace, relative);
    const currentState = fileState(currentAbsolute);
    if (!new Set(["missing", "directory"]).has(currentState)) {
      throw migrationError("INSTALL_DIRECTORY_CONTENT_UNSAFE", `${currentAbsolute} 必须是缺失或安全 data 目录`);
    }
    if (currentState === "directory") assertDataDirectoryContents(currentAbsolute);
    assertDataDirectoryContents(stagedAbsolute);
    const quarantineAbsolute = path.join(
      workspace,
      "business",
      "migrations",
      `${MIGRATION_ID}-rollback-quarantine`,
      attemptId,
      definition.agentId,
      "data"
    );
    if (fileState(quarantineAbsolute) !== "missing") {
      throw migrationError("INSTALL_QUARANTINE_CONFLICT", `rollback 隔离目录已存在：${quarantineAbsolute}`);
    }
    return {
      agentId: definition.agentId,
      relative,
      currentAbsolute,
      stagedAbsolute,
      quarantineAbsolute,
      beforeDirectorySha256: currentState === "missing" ? "missing" : directoryDigest(currentAbsolute),
      afterDirectorySha256: directoryDigest(stagedAbsolute)
    };
  });
}

async function normalizeInstallForRollbackRebuild(
  workspace,
  intent,
  assertIdentityGate,
  operationLockHooks
) {
  if (!Array.isArray(intent.installDirectories)) return;
  for (const binding of intent.installDirectories) {
    validateRecoveryJournalBindingPaths(workspace, binding);
    const quarantine = directoryDigestOrMissing(binding.quarantineAbsolute);
    if (quarantine !== "missing" && quarantine !== binding.beforeDirectorySha256) {
      throw migrationError("INSTALL_DIRECTORY_UNKNOWN", `${binding.relative} 旧 quarantine 无法与 signed journal 对账`);
    }
    const currentState = fileState(binding.currentAbsolute);
    if (currentState === "directory") {
      assertDataDirectoryContents(binding.currentAbsolute);
      continue;
    }
    if (currentState === "missing"
      && binding.beforeDirectorySha256 === "missing"
      && quarantine === "missing") continue;
    if (currentState === "missing" && quarantine === binding.beforeDirectorySha256) {
      await operationLockHooks?.beforeRollbackNormalizeRename?.({
        binding: structuredClone(binding)
      });
      assertIdentityGate();
      validateRecoveryJournalBindingPaths(workspace, binding);
      if (fileState(binding.currentAbsolute) !== "missing"
        || directoryDigestOrMissing(binding.quarantineAbsolute) !== binding.beforeDirectorySha256) {
        throw migrationError(
          "INSTALL_DIRECTORY_CHANGED",
          `${binding.relative} 在 rollback normalize 最终 CAS 前发生变化`
        );
      }
      fs.renameSync(binding.quarantineAbsolute, binding.currentAbsolute);
      syncDirectory(path.dirname(binding.currentAbsolute));
      syncDirectory(path.dirname(binding.quarantineAbsolute));
      continue;
    }
    throw migrationError("INSTALL_DIRECTORY_UNKNOWN", `${binding.relative} 无法在 rollback 前对账`);
  }
}

function collectRetainedQuarantineDirectories(workspace, intent) {
  const retained = validateRetainedQuarantineDirectories(workspace, intent);
  for (const binding of intent.installDirectories ?? []) {
    validateRecoveryJournalBindingPaths(workspace, binding);
    const digest = directoryDigestOrMissing(binding.quarantineAbsolute);
    if (digest === "missing") continue;
    if (digest !== binding.beforeDirectorySha256) {
      throw migrationError("INSTALL_DIRECTORY_UNKNOWN", `${binding.relative} 旧 quarantine 无法与 signed journal 对账`);
    }
    retained.push({
      agentId: binding.agentId,
      quarantineAbsolute: path.resolve(binding.quarantineAbsolute),
      directorySha256: digest
    });
  }
  const uniqueByPath = new Map();
  for (const entry of retained) {
    const existing = uniqueByPath.get(entry.quarantineAbsolute);
    if (existing && stableJson(existing) !== stableJson(entry)) {
      throw migrationError("INSTALL_JOURNAL_PATH_MISMATCH", `${entry.quarantineAbsolute} retained quarantine 绑定冲突`);
    }
    uniqueByPath.set(entry.quarantineAbsolute, entry);
  }
  return [...uniqueByPath.values()].sort((left, right) => (
    left.quarantineAbsolute.localeCompare(right.quarantineAbsolute)
  ));
}

function validateRetainedQuarantineDirectories(workspace, intent) {
  const retained = intent.retainedQuarantineDirectories ?? [];
  if (!Array.isArray(retained)) {
    throw migrationError("MIGRATION_INTENT_INVALID", "retainedQuarantineDirectories 必须是数组");
  }
  const allowedRoots = [
    path.join(workspace, "business", "migrations", `${MIGRATION_ID}-quarantine`),
    path.join(workspace, "business", "migrations", `${MIGRATION_ID}-rollback-quarantine`)
  ].map((entry) => path.resolve(entry));
  return retained.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || stableJson(Object.keys(entry).sort()) !== stableJson([
        "agentId",
        "directorySha256",
        "quarantineAbsolute"
      ])) {
      throw migrationError("MIGRATION_INTENT_INVALID", `retainedQuarantineDirectories[${index}] schema 无效`);
    }
    const agentId = normalizeText(entry.agentId);
    const directorySha256 = normalizeText(entry.directorySha256);
    const quarantineAbsolute = path.resolve(String(entry.quarantineAbsolute ?? ""));
    if (!agentId || !/^[a-z0-9_-]{1,64}$/i.test(agentId)
      || !/^[a-f0-9]{64}$/.test(directorySha256)
      || !allowedRoots.some((root) => isInside(root, quarantineAbsolute))) {
      throw migrationError("INSTALL_JOURNAL_PATH_MISMATCH", `retainedQuarantineDirectories[${index}] 绑定无效`);
    }
    assertNoSymlinkPath(workspace, quarantineAbsolute, { allowMissing: true });
    const state = fileState(quarantineAbsolute);
    if (!new Set(["missing", "directory"]).has(state)) {
      throw migrationError("INSTALL_DIRECTORY_UNKNOWN", `${quarantineAbsolute} retained quarantine 类型无效`);
    }
    if (state === "directory" && directoryDigest(quarantineAbsolute) !== directorySha256) {
      throw migrationError("INSTALL_DIRECTORY_UNKNOWN", `${quarantineAbsolute} retained quarantine 摘要不匹配`);
    }
    return { agentId, quarantineAbsolute, directorySha256 };
  });
}

function validateRecoveryJournalBindingPaths(workspace, binding) {
  const relative = normalizeRelativePath(binding.relative);
  const expectedCurrent = safeWorkspaceChild(workspace, relative);
  if (path.resolve(binding.currentAbsolute) !== path.resolve(expectedCurrent)) {
    throw migrationError("INSTALL_JOURNAL_PATH_MISMATCH", `${relative} current path 未绑定 production workspace`);
  }
  const quarantine = path.resolve(binding.quarantineAbsolute);
  if (!isInside(workspace, quarantine)) {
    throw migrationError("INSTALL_JOURNAL_PATH_MISMATCH", `${relative} quarantine path 越界`);
  }
  assertNoSymlinkPath(workspace, expectedCurrent, { allowMissing: true });
  assertNoSymlinkPath(workspace, path.dirname(quarantine), { allowMissing: true });
  if (fileState(quarantine) !== "missing") assertNoSymlinkPath(workspace, quarantine);
}

function definitionsFromIntent(intent) {
  if (!Array.isArray(intent.agents) || intent.agents.length === 0) {
    throw migrationError("MIGRATION_INTENT_INVALID", "intent 缺少 Agent 定义");
  }
  return intent.agents.map((agent) => ({
    agentId: agent.agentId,
    application: agent.application,
    queue: agent.queue
  })).sort((left, right) => left.agentId.localeCompare(right.agentId));
}

function assertJournalDatabasePaths(definitions, bindings) {
  const expected = definitions.map((definition) => path.posix.dirname(definition.application)).sort();
  const actual = (bindings ?? []).map((binding) => normalizeRelativePath(binding.relative)).sort();
  if (stableJson(expected) !== stableJson(actual)) {
    throw migrationError("INSTALL_JOURNAL_SET_MISMATCH", "install journal 与 Agent data 目录集合不一致");
  }
}

function assertInstallBindingsAnchored(workspace, stagingWorkspace, bindings) {
  for (const binding of bindings ?? []) {
    validateRecoveryJournalBindingPaths(workspace, binding);
    const expectedStaged = safeWorkspaceChild(stagingWorkspace, binding.relative);
    if (path.resolve(binding.stagedAbsolute) !== path.resolve(expectedStaged)) {
      throw migrationError("INSTALL_JOURNAL_PATH_MISMATCH", `${binding.relative} staged path 未绑定 staging workspace`);
    }
    validateInstallBindingPaths(binding);
  }
}

function assertForwardInstallHasNotStarted(workspace, stagingWorkspace, intent) {
  if ((intent.installedDirectories?.length ?? 0) > 0) {
    throw migrationError("INSTALL_ALREADY_STARTED", "staged-ready intent 已包含 installedDirectories");
  }
  for (const binding of intent.installDirectories ?? []) {
    if (reconcileDirectoryInstall(workspace, stagingWorkspace, binding) !== "before") {
      throw migrationError("INSTALL_ALREADY_STARTED", `${binding.relative} 已越过首个 rename 边界`);
    }
  }
}

function assertDataDirectoryContents(directory) {
  const allowed = /^(?:sunabot|session-queue)\.sqlite$/;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !allowed.test(entry.name)) {
      throw migrationError("INSTALL_DIRECTORY_CONTENT_UNSAFE", `${directory} 包含不允许随目录切换的条目：${entry.name}`);
    }
  }
}

function reconcileDirectoryInstall(workspace, stagingWorkspace, binding) {
  const currentState = directoryDigestOrMissing(binding.currentAbsolute);
  const stagedState = directoryDigestOrMissing(binding.stagedAbsolute);
  const quarantineState = directoryDigestOrMissing(binding.quarantineAbsolute);
  if (currentState === binding.beforeDirectorySha256
    && stagedState === binding.afterDirectorySha256
    && quarantineState === "missing") return "before";
  if (currentState === "missing"
    && stagedState === binding.afterDirectorySha256
    && quarantineState === binding.beforeDirectorySha256) return "quarantined";
  if (currentState === binding.afterDirectorySha256
    && stagedState === "missing"
    && quarantineState === binding.beforeDirectorySha256) return "installed";
  return "unknown";
}

function describeInstallDirectoryState(binding) {
  const entries = (directory) => fileState(directory) === "directory"
    ? fs.readdirSync(directory).sort().join("|")
    : fileState(directory);
  return [
    `current=${directoryDigestOrMissing(binding.currentAbsolute)}[${entries(binding.currentAbsolute)}]`,
    `staged=${directoryDigestOrMissing(binding.stagedAbsolute)}[${entries(binding.stagedAbsolute)}]`,
    `quarantine=${directoryDigestOrMissing(binding.quarantineAbsolute)}[${entries(binding.quarantineAbsolute)}]`,
    `before=${binding.beforeDirectorySha256}`,
    `after=${binding.afterDirectorySha256}`
  ].join(",");
}

function assertProductionStillBeforeOrInstalled(workspace, stagingWorkspace, intent) {
  for (const binding of intent.installDirectories) {
    const state = reconcileDirectoryInstall(workspace, stagingWorkspace, binding);
    if (!new Set(["before", "quarantined", "installed"]).has(state)) {
      throw migrationError(
        "INSTALL_DIRECTORY_UNKNOWN",
        `${binding.relative} 当前状态无法与 journal 对账 (${describeInstallDirectoryState(binding)})`
      );
    }
  }
}

function persistInstalledDirectory(intentPath, intent, relative) {
  if (intent.installedDirectories?.includes(relative)) return intent;
  return updateIntent(intentPath, intent, {
    installedDirectories: [...(intent.installedDirectories ?? []), relative]
  });
}

function preflightInstallFilesystems(bindings, deviceProbe = (directory) => fs.statSync(directory).dev) {
  for (const binding of bindings) {
    validateInstallBindingPaths(binding);
    fs.mkdirSync(path.dirname(binding.quarantineAbsolute), { recursive: true, mode: 0o700 });
    validateInstallBindingPaths(binding);
    const devices = [
      deviceProbe(path.dirname(binding.currentAbsolute)),
      deviceProbe(path.dirname(binding.stagedAbsolute)),
      deviceProbe(path.dirname(binding.quarantineAbsolute))
    ];
    if (new Set(devices).size !== 1) {
      throw migrationError("INSTALL_CROSS_DEVICE", `${binding.relative} current/staging/quarantine 不在同一 filesystem，零 rename 失败关闭`);
    }
  }
}

function validateInstallBindingPaths(binding) {
  const currentRoot = rootForBoundRelative(binding.currentAbsolute, binding.relative);
  const stagedRoot = rootForBoundRelative(binding.stagedAbsolute, binding.relative);
  assertNoSymlinkPath(currentRoot, binding.currentAbsolute, { allowMissing: true });
  assertNoSymlinkPath(stagedRoot, binding.stagedAbsolute, { allowMissing: true });
  assertNoSymlinkPath(currentRoot, path.dirname(binding.quarantineAbsolute), { allowMissing: true });
  if (fileState(binding.quarantineAbsolute) !== "missing") {
    assertNoSymlinkPath(currentRoot, binding.quarantineAbsolute);
  }
}

function rootForBoundRelative(absolute, relative) {
  const segments = normalizeRelativePath(relative).split("/").filter(Boolean);
  return path.resolve(absolute, ...segments.map(() => ".."));
}

function assertDefinitionSetsEqual(left, right, code) {
  const project = (definitions) => definitions.map((definition) => ({
    agentId: definition.agentId,
    application: definition.application,
    queue: definition.queue
  }));
  if (stableJson(project(left)) !== stableJson(project(right))) {
    throw migrationError(code, "Agent application/queue 数据库集合不一致");
  }
}

function directoryDigest(directory) {
  assertDataDirectoryContents(directory);
  return canonicalSha256(fs.readdirSync(directory).sort().map((name) => ({
    name,
    bytes: fs.statSync(path.join(directory, name)).size,
    sha256: sha256File(path.join(directory, name))
  })));
}

function directoryDigestOrMissing(directory) {
  const state = fileState(directory);
  if (state === "missing") return "missing";
  if (state !== "directory") return "invalid";
  try { return directoryDigest(directory); } catch { return "invalid"; }
}

async function withMigrationOperationLock(workspace, options, operation) {
  const lock = await acquireMigrationOperationLock(workspace, options);
  try {
    await options.operationLockHooks?.afterAcquire?.({
      lockPath: lock.lockPath,
      evidencePath: lock.evidencePath,
      record: structuredClone(lock.record)
    });
    await invokeOperationLockFault(options, "operation-lock:after-acquire", { lockPath: lock.lockPath });
    return await operation();
  } finally {
    await releaseMigrationOperationLock(lock, options);
  }
}

async function acquireMigrationOperationLock(workspace, options) {
  const paths = migrationOperationLockPaths(workspace);
  const processIdentity = currentProcessIdentity();
  const record = validateMigrationOperationLockRecord({
    schemaVersion: OPERATION_LOCK_SCHEMA_VERSION,
    kind: OPERATION_LOCK_KIND,
    migrationId: MIGRATION_ID,
    pid: process.pid,
    processIdentity,
    ownerToken: crypto.randomBytes(32).toString("hex")
  });
  const metadata = operationOwnerMetadata(record);
  const evidencePath = path.join(paths.directory, operationEvidenceName(metadata));
  const raw = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");

  for (let attempt = 0; attempt < OPERATION_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (await reconcileMigrationOperationArtifacts(paths, options)) continue;
      let descriptor;
      let evidence;
      let evidenceCreated = false;
      let published = false;
      try {
        descriptor = fs.openSync(
          evidencePath,
          fs.constants.O_WRONLY
            | fs.constants.O_CREAT
            | fs.constants.O_EXCL
            | noFollowOpenFlag(),
          0o600
        );
        evidenceCreated = true;
        fs.fchmodSync(descriptor, 0o600);
        await invokeOperationLockFault(options, "operation-lock:after-evidence-open", { evidencePath });
        fs.writeFileSync(descriptor, raw);
        await invokeOperationLockFault(options, "operation-lock:after-evidence-write", { evidencePath });
        fs.fsyncSync(descriptor);
        await invokeOperationLockFault(options, "operation-lock:after-evidence-fsync", { evidencePath });
        fs.closeSync(descriptor);
        descriptor = undefined;
        evidence = readOperationLockSnapshot(evidencePath);
        assertOperationRecordMatchesMetadata(evidence.record, metadata);
        fs.linkSync(evidencePath, paths.lockPath);
        published = true;
        await invokeOperationLockFault(options, "operation-lock:after-canonical-link", {
          evidencePath,
          lockPath: paths.lockPath
        });
        syncDirectory(paths.directory);
        await invokeOperationLockFault(options, "operation-lock:after-publish-dir-fsync", {
          evidencePath,
          lockPath: paths.lockPath
        });
        const canonical = readOperationLockSnapshot(paths.lockPath);
        evidence = readOperationLockSnapshot(evidencePath);
        assertPublishedOperationLock(canonical, evidence, record.ownerToken);
        return {
          ...paths,
          evidencePath,
          identity: canonical.identity,
          record
        };
      } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (published) {
          const canonical = readOptionalOperationLockSnapshot(paths.lockPath);
          if (canonical
            && canonical.record?.ownerToken === record.ownerToken
            && evidence
            && sameOperationLockIdentity(canonical.identity, evidence.identity)) {
            try {
              await claimAndRemoveMigrationOperationLock(
                { ...paths, evidencePath, identity: canonical.identity, record },
                { operationLockHooks: {} }
              );
            } catch { /* valid published evidence remains fail-closed */ }
          }
        } else if (evidenceCreated) {
          const partial = readOptionalOperationLockSnapshot(evidencePath, { allowPartial: true });
          if (partial) {
            removeUniqueOperationArtifact(paths.directory, evidencePath, partial);
            syncDirectory(paths.directory);
          }
        }
        throw error;
      }
    } catch (error) {
      if (isOperationLockRace(error) || error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw migrationError("MIGRATION_OPERATION_LOCK_BUSY", "迁移操作锁竞争未在有界次数内收敛");
}

async function releaseMigrationOperationLock(lock, options) {
  const source = readOptionalOperationLockSnapshot(lock.lockPath);
  if (!source || !sameOperationLockLease(source.record, lock.record)) {
    throw migrationError("MIGRATION_OPERATION_LOCK_LOST", "迁移操作锁 lease 已丢失；拒绝清理其他 owner");
  }
  const artifacts = readMigrationOperationArtifacts(lock);
  const evidence = matchingOperationEvidence(artifacts, source.identity);
  if (evidence.length !== 1) {
    throw migrationError("MIGRATION_OPERATION_LOCK_LOST", "迁移操作锁 evidence 已丢失；拒绝清理其他 owner");
  }
  assertPublishedOperationLock(source, evidence[0].snapshot, source.record.ownerToken);
  await claimAndRemoveMigrationOperationLock({
    ...lock,
    evidencePath: evidence[0].path,
    identity: source.identity,
    record: source.record
  }, options);
}

async function reconcileMigrationOperationArtifacts(paths, options) {
  const canonicalBefore = readOptionalOperationLockSnapshot(paths.lockPath);
  const artifacts = readMigrationOperationArtifacts(paths);
  const canonical = readOptionalOperationLockSnapshot(paths.lockPath);
  if (!sameOptionalOperationLockSnapshot(canonicalBefore, canonical)) {
    operationLockChanged(paths.lockPath);
  }
  if (canonical) {
    if (!canonical.record || canonical.stat.nlink !== 2n) operationLockInvalid("canonical lock 结构无效");
    const evidence = matchingOperationEvidence(artifacts, canonical.identity);
    if (evidence.length !== 1 || evidence[0].snapshot.stat.nlink !== 2n) {
      operationLockInvalid("canonical lock 缺少唯一同 inode evidence");
    }
    assertPublishedOperationLock(canonical, evidence[0].snapshot, canonical.record.ownerToken);

    const claims = artifacts.filter((entry) => entry.metadata.kind === "claim");
    for (const claim of claims) {
      if (!sameOperationLockLease(claim.snapshot.record, canonical.record)) {
        if (await operationOwnerIsLive(
          operationOwnerMetadata(claim.snapshot.record),
          claim.snapshot.record,
          options
        )) operationLockInvalid("canonical 与 live claim 同时存在");
        removeClaimPair(paths.directory, artifacts, claim);
        syncDirectory(paths.directory);
        return true;
      }
      removeClaimPair(paths.directory, artifacts, claim);
      removeOrphanedLeaseArtifacts(paths.directory, artifacts, canonical.record, {
        preserve: new Set([evidence[0].path])
      });
      removeAbandonedClaimOwnerArtifacts(paths.directory, artifacts, claim.metadata, {
        preserve: new Set([evidence[0].path])
      });
      syncDirectory(paths.directory);
      return true;
    }

    if (await operationOwnerIsLive(evidence[0].metadata, canonical.record, options)) {
      operationLockHeld(canonical.record.pid);
    }
    await claimAndRemoveMigrationOperationLock({
      ...paths,
      evidencePath: evidence[0].path,
      identity: canonical.identity,
      record: canonical.record
    }, options);
    return true;
  }

  for (const claim of artifacts.filter((entry) => entry.metadata.kind === "claim")) {
    if (!operationRecordMatchesMetadata(claim.snapshot.record, claim.metadata)) {
      await republishClaimedSuccessor(paths, claim.path, claim.snapshot, options, claim.metadata);
      return true;
    }
    if (await operationOwnerIsLive(claim.metadata, claim.snapshot.record, options)) {
      operationLockHeld(claim.metadata.pid);
    }
    removeClaimPair(paths.directory, artifacts, claim);
    syncDirectory(paths.directory);
    return true;
  }

  if (artifacts.length === 0) return false;
  for (const artifact of artifacts) {
    if (artifact.snapshot.stat.nlink !== 1n) operationLockInvalid("孤立 operation artifact 链接计数无效");
    const ownerMetadata = artifact.snapshot.record
      ? operationOwnerMetadata(artifact.snapshot.record)
      : artifact.metadata;
    if (await operationOwnerIsLive(ownerMetadata, artifact.snapshot.record, options)) {
      operationLockHeld(artifact.metadata.pid);
    }
  }
  for (const artifact of artifacts) {
    removeUniqueOperationArtifact(paths.directory, artifact.path, artifact.snapshot);
  }
  syncDirectory(paths.directory);
  return true;
}

async function claimAndRemoveMigrationOperationLock(lock, options) {
  const metadata = operationOwnerMetadata(lock.record);
  const claimPath = path.join(
    lock.directory,
    operationClaimName(metadata, crypto.randomBytes(32).toString("hex"))
  );
  await invokeOperationLockFault(options, "operation-lock:before-canonical-claim", {
    lockPath: lock.lockPath,
    claimPath
  });
  try { fs.renameSync(lock.lockPath, claimPath); }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST") operationLockChanged(lock.lockPath);
    throw error;
  }
  await invokeOperationLockFault(options, "operation-lock:after-canonical-claim", {
    lockPath: lock.lockPath,
    claimPath
  });
  syncDirectory(lock.directory);
  await invokeOperationLockFault(options, "operation-lock:after-claim-dir-fsync", {
    lockPath: lock.lockPath,
    claimPath
  });
  const claimed = readOperationLockSnapshot(claimPath);
  if (!sameOperationLockIdentity(claimed.identity, lock.identity)
    || !sameOperationLockLease(claimed.record, lock.record)) {
    await republishClaimedSuccessor(lock, claimPath, claimed, options, metadata);
    throw migrationError("MIGRATION_OPERATION_LOCK_CHANGED", "claim 捕获了后继锁；后继锁已无覆盖恢复");
  }
  const evidence = readOperationLockSnapshot(lock.evidencePath);
  if (!sameOperationLockIdentity(evidence.identity, lock.identity)
    || !sameOperationLockLease(evidence.record, lock.record)
    || claimed.stat.nlink !== 2n
    || evidence.stat.nlink !== 2n) {
    throw migrationError("MIGRATION_OPERATION_LOCK_CHANGED", "claim 与原 evidence 不一致；保留证据");
  }
  removeUniqueOperationArtifact(lock.directory, claimPath, claimed);
  await invokeOperationLockFault(options, "operation-lock:after-claim-unlink", { claimPath });
  const terminalEvidence = readOperationLockSnapshot(lock.evidencePath);
  if (!sameOperationLockIdentity(terminalEvidence.identity, lock.identity)
    || !sameOperationLockLease(terminalEvidence.record, lock.record)
    || terminalEvidence.stat.nlink !== 1n) {
    throw migrationError("MIGRATION_OPERATION_LOCK_CHANGED", "release evidence 终态无效");
  }
  removeUniqueOperationArtifact(lock.directory, lock.evidencePath, terminalEvidence);
  await invokeOperationLockFault(options, "operation-lock:after-evidence-unlink", {
    evidencePath: lock.evidencePath
  });
  syncDirectory(lock.directory);
}

async function republishClaimedSuccessor(lock, claimPath, claimed, options, claimMetadata) {
  if (!claimed.record) operationLockInvalid("被 claim 的 successor record 无效");
  const metadata = operationOwnerMetadata(claimed.record);
  const recoveryPath = path.join(
    lock.directory,
    operationRecoveryEvidenceName(metadata, crypto.randomBytes(32).toString("hex"))
  );
  let recovery;
  try {
    const descriptor = fs.openSync(
      recoveryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowOpenFlag(),
      0o600
    );
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, claimed.raw);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    recovery = readOperationLockSnapshot(recoveryPath);
    await invokeOperationLockFault(options, "operation-lock:after-recovery-evidence-fsync", {
      recoveryPath,
      claimPath
    });
    fs.linkSync(recoveryPath, lock.lockPath);
    await invokeOperationLockFault(options, "operation-lock:after-recovery-canonical-link", {
      recoveryPath,
      lockPath: lock.lockPath
    });
    syncDirectory(lock.directory);
    await invokeOperationLockFault(options, "operation-lock:after-recovery-dir-fsync", {
      recoveryPath,
      lockPath: lock.lockPath
    });
    const canonical = readOperationLockSnapshot(lock.lockPath);
    recovery = readOperationLockSnapshot(recoveryPath);
    assertPublishedOperationLock(canonical, recovery, claimed.record.ownerToken);
    const artifacts = readMigrationOperationArtifacts(lock);
    removeClaimPair(lock.directory, artifacts, {
      path: claimPath,
      metadata: claimMetadata,
      snapshot: claimed
    });
    removeOrphanedLeaseArtifacts(lock.directory, artifacts, claimed.record, {
      preserve: new Set([recoveryPath])
    });
    removeAbandonedClaimOwnerArtifacts(lock.directory, artifacts, claimMetadata, {
      preserve: new Set([recoveryPath, claimPath])
    });
    syncDirectory(lock.directory);
  } catch (error) {
    if (error?.code === "EEXIST" && recovery) {
      const current = readOptionalOperationLockSnapshot(recoveryPath);
      if (current && sameOperationLockIdentity(current.identity, recovery.identity)) {
        removeUniqueOperationArtifact(lock.directory, recoveryPath, current);
        syncDirectory(lock.directory);
      }
    }
    throw error;
  }
}

function matchingOperationEvidence(artifacts, identity) {
  return artifacts.filter((entry) => (
    entry.metadata.kind !== "claim"
    && sameOperationLockIdentity(entry.snapshot.identity, identity)
  ));
}

function removeClaimPair(directory, artifacts, claim) {
  const evidence = matchingOperationEvidence(artifacts, claim.snapshot.identity);
  if (evidence.length !== 1
    || claim.snapshot.stat.nlink !== 2n
    || evidence[0].snapshot.stat.nlink !== 2n) {
    operationLockInvalid("claim 缺少唯一同 inode evidence");
  }
  removeUniqueOperationArtifact(directory, claim.path, claim.snapshot);
  removeUniqueOperationArtifact(directory, evidence[0].path, evidence[0].snapshot);
}

function removeOrphanedLeaseArtifacts(directory, artifacts, record, options = {}) {
  for (const artifact of artifacts) {
    if (options.preserve?.has(artifact.path) || artifact.metadata.kind === "claim") continue;
    if (!sameOperationLockLease(artifact.snapshot.record, record)) continue;
    if (artifact.snapshot.stat.nlink !== 1n) continue;
    removeUniqueOperationArtifact(directory, artifact.path, artifact.snapshot);
  }
}

function removeAbandonedClaimOwnerArtifacts(directory, artifacts, metadata, options = {}) {
  for (const artifact of artifacts) {
    if (options.preserve?.has(artifact.path)) continue;
    if (!sameOperationArtifactOwner(artifact.metadata, metadata)) continue;
    if (artifact.snapshot.stat.nlink !== 1n) continue;
    removeUniqueOperationArtifact(directory, artifact.path, artifact.snapshot);
  }
}

function ensureMigrationOperationDirectory(workspace) {
  const businessDirectory = path.join(workspace, "business");
  assertNoSymlinkPath(workspace, businessDirectory);
  if (fileState(businessDirectory) !== "directory") {
    throw migrationError("MIGRATION_OPERATION_LOCK_PATH_INVALID", "business 目录不存在或类型无效");
  }
  const directory = path.join(businessDirectory, "migrations");
  if (fileState(directory) === "missing") {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  if (fileState(directory) !== "directory") {
    throw migrationError("MIGRATION_OPERATION_LOCK_PATH_INVALID", "migrations 路径必须是普通目录");
  }
  assertNoSymlinkPath(workspace, directory);
  return directory;
}

function migrationOperationLockPaths(workspace) {
  const directory = ensureMigrationOperationDirectory(workspace);
  return { workspace, directory, lockPath: path.join(directory, `${MIGRATION_ID}-operation.lock`) };
}

function readMigrationOperationArtifacts(paths) {
  const names = fs.readdirSync(paths.directory).filter((name) => name.startsWith(`.${MIGRATION_ID}-operation.`));
  if (names.length > OPERATION_LOCK_MAX_ARTIFACTS) operationLockInvalid("operation artifact 数量超过上限");
  return names.sort().map((name) => {
    const metadata = parseOperationArtifactName(name);
    if (!metadata) operationLockInvalid(`operation artifact 名称无效：${name}`);
    const artifactPath = path.join(paths.directory, name);
    const snapshot = readOperationLockSnapshot(artifactPath, {
      allowPartial: metadata.kind !== "claim"
    });
    if (snapshot.record && metadata.kind !== "claim") {
      assertOperationRecordMatchesMetadata(snapshot.record, metadata);
    }
    return { path: artifactPath, metadata, snapshot };
  });
}

function readOptionalOperationLockSnapshot(filePath, options = {}) {
  try { return readOperationLockSnapshot(filePath, options); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function readOperationLockSnapshot(filePath, options = {}) {
  const initial = fs.lstatSync(filePath, { bigint: true });
  assertOperationLockFileStat(initial, filePath, options);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowOpenFlag());
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertOperationLockFileStat(opened, filePath, options);
    if (!sameOperationLockFileSnapshot(initial, opened)) operationLockChanged(filePath);
    const raw = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    assertOperationLockFileStat(after, filePath, options);
    if (!sameOperationLockFileSnapshot(opened, after) || BigInt(raw.length) !== after.size) {
      operationLockChanged(filePath);
    }
    const atPath = fs.lstatSync(filePath, { bigint: true });
    assertOperationLockFileStat(atPath, filePath, options);
    if (!sameOperationLockFileSnapshot(after, atPath)) operationLockChanged(filePath);
    let record = null;
    try { record = validateMigrationOperationLockRecord(JSON.parse(raw.toString("utf8"))); }
    catch (error) {
      if (!options.allowPartial) {
        if (error?.code === "MIGRATION_OPERATION_LOCK_INVALID") throw error;
        operationLockInvalid("迁移操作锁 JSON 无效或不完整");
      }
    }
    return {
      identity: operationLockIdentity(after),
      raw,
      record,
      stat: after
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateMigrationOperationLockRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁必须是 JSON object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...OPERATION_LOCK_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁字段集合无效");
  }
  if (value.schemaVersion !== OPERATION_LOCK_SCHEMA_VERSION || value.migrationId !== MIGRATION_ID) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁版本或迁移 ID 无效");
  }
  if (value.kind !== OPERATION_LOCK_KIND) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁 kind 无效");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁 PID 无效");
  }
  if (typeof value.processIdentity !== "string"
    || value.processIdentity.length < 1
    || value.processIdentity.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.processIdentity)) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁进程启动身份无效");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.ownerToken)) {
    throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", "迁移操作锁 owner token 无效");
  }
  return value;
}

function assertOperationLockFileStat(stat, filePath, options = {}) {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stat.uid;
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink < 1n
    || stat.nlink > 2n
    || (!options.allowPartial && stat.size < 1n)
    || stat.size > BigInt(OPERATION_LOCK_MAX_BYTES)
    || (stat.mode & 0o777n) !== 0o600n
    || stat.uid !== currentUid) {
    throw migrationError(
      "MIGRATION_OPERATION_LOCK_INVALID",
      `迁移操作锁 artifact 必须是当前用户拥有的 0600 普通文件：${filePath}`
    );
  }
}

async function operationOwnerIsLive(metadata, record, options) {
  const expectedDigest = metadata.identityDigest;
  if (record && operationIdentityDigest(record.processIdentity) !== expectedDigest) {
    operationLockInvalid("record 与 artifact process identity 不一致");
  }
  if (metadata.pid === process.pid) {
    return operationIdentityDigest(currentProcessIdentity()) === expectedDigest;
  }
  let observed;
  try {
    observed = options.operationLockHooks?.processProbe
      ? await options.operationLockHooks.processProbe(metadata.pid)
      : defaultOperationProcessProbe(metadata.pid);
  } catch {
    observed = processIsPresent(metadata.pid)
      ? { status: "present", identity: null }
      : { status: "absent" };
  }
  if (observed?.status === "absent") return false;
  if (observed?.status !== "present" || typeof observed.identity !== "string") return true;
  return operationIdentityDigest(observed.identity) === expectedDigest;
}

function currentProcessIdentity() {
  if (process.platform === "linux") {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
    if (!/^[a-f0-9-]{36}$/u.test(bootId)) operationIdentityUnavailable();
    return `linux:${bootId}:${readLinuxProcessStartTicks("/proc/self/stat")}`;
  }
  if (process.platform === "darwin") {
    const startedAt = Math.floor(Number(performance.timeOrigin) / 1_000);
    if (!Number.isSafeInteger(startedAt) || startedAt < 1) operationIdentityUnavailable();
    return `darwin:${startedAt}`;
  }
  operationIdentityUnavailable();
}

function defaultOperationProcessProbe(pid) {
  if (!processIsPresent(pid)) return { status: "absent" };
  try {
    let identity;
    if (process.platform === "linux") {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      identity = `linux:${bootId}:${readLinuxProcessStartTicks(`/proc/${pid}/stat`)}`;
    } else if (process.platform === "darwin") {
      const observed = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2_000,
        env: { ...process.env, LANG: "C", LC_ALL: "C" }
      });
      const timestamp = Date.parse(String(observed.stdout ?? "").trim());
      if (observed.error || observed.status !== 0 || !Number.isFinite(timestamp)) {
        return { status: "present", identity: null };
      }
      identity = `darwin:${Math.floor(timestamp / 1_000)}`;
    } else {
      return { status: "present", identity: null };
    }
    return processIsPresent(pid) ? { status: "present", identity } : { status: "absent" };
  } catch {
    return processIsPresent(pid) ? { status: "present", identity: null } : { status: "absent" };
  }
}

function readLinuxProcessStartTicks(statPath) {
  const value = fs.readFileSync(statPath, "utf8");
  const close = value.lastIndexOf(")");
  const fields = close >= 0 ? value.slice(close + 1).trim().split(/\s+/u) : [];
  const startTicks = fields[19];
  if (!/^[0-9]+$/u.test(String(startTicks ?? ""))) operationIdentityUnavailable();
  return startTicks;
}

function processIsPresent(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function operationIdentityUnavailable() {
  throw migrationError("MIGRATION_OPERATION_IDENTITY_UNAVAILABLE", "无法生成可信的当前进程启动身份");
}

function operationOwnerMetadata(record) {
  return {
    kind: "evidence",
    pid: record.pid,
    identityDigest: operationIdentityDigest(record.processIdentity),
    ownerToken: record.ownerToken
  };
}

function operationIdentityDigest(identity) {
  return crypto.createHash("sha256").update(String(identity)).digest("hex");
}

function operationEvidenceName(metadata) {
  return `.${MIGRATION_ID}-operation.${metadata.pid}.${metadata.identityDigest}.${metadata.ownerToken}.evidence`;
}

function operationClaimName(metadata, nonce) {
  return `.${MIGRATION_ID}-operation.${metadata.pid}.${metadata.identityDigest}.${metadata.ownerToken}.${nonce}.claim`;
}

function operationRecoveryEvidenceName(metadata, nonce) {
  return `.${MIGRATION_ID}-operation.${metadata.pid}.${metadata.identityDigest}.${metadata.ownerToken}.${nonce}.recovery.evidence`;
}

function parseOperationArtifactName(name) {
  const escaped = escapeRegExp(MIGRATION_ID);
  let match = new RegExp(
    `^\\.${escaped}-operation\\.([1-9][0-9]*)\\.([a-f0-9]{64})\\.([a-f0-9]{64})\\.evidence$`,
    "u"
  ).exec(name);
  if (match) return artifactMetadata("evidence", match);
  match = new RegExp(
    `^\\.${escaped}-operation\\.([1-9][0-9]*)\\.([a-f0-9]{64})\\.([a-f0-9]{64})\\.([a-f0-9]{64})\\.claim$`,
    "u"
  ).exec(name);
  if (match) return artifactMetadata("claim", match);
  match = new RegExp(
    `^\\.${escaped}-operation\\.([1-9][0-9]*)\\.([a-f0-9]{64})\\.([a-f0-9]{64})\\.([a-f0-9]{64})\\.recovery\\.evidence$`,
    "u"
  ).exec(name);
  return match ? artifactMetadata("recovery", match) : null;
}

function artifactMetadata(kind, match) {
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return { kind, pid, identityDigest: match[2], ownerToken: match[3] };
}

function assertOperationRecordMatchesMetadata(record, metadata) {
  if (!operationRecordMatchesMetadata(record, metadata)) {
    operationLockInvalid("operation artifact 文件名与 record 不匹配");
  }
}

function operationRecordMatchesMetadata(record, metadata) {
  return Boolean(
    record
    && record.pid === metadata.pid
    && record.ownerToken === metadata.ownerToken
    && operationIdentityDigest(record.processIdentity) === metadata.identityDigest
  );
}

function sameOperationArtifactOwner(left, right) {
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.identityDigest === right.identityDigest
    && left.ownerToken === right.ownerToken
  );
}

function sameOperationLockLease(left, right) {
  return Boolean(
    left
    && right
    && left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.migrationId === right.migrationId
    && left.pid === right.pid
    && left.processIdentity === right.processIdentity
    && left.ownerToken === right.ownerToken
  );
}

function assertPublishedOperationLock(canonical, evidence, ownerToken) {
  if (!canonical.record
    || !evidence.record
    || canonical.record.ownerToken !== ownerToken
    || evidence.record.ownerToken !== ownerToken
    || !canonical.raw.equals(evidence.raw)
    || !sameOperationLockIdentity(canonical.identity, evidence.identity)
    || canonical.stat.nlink !== 2n
    || evidence.stat.nlink !== 2n) {
    operationLockInvalid("canonical 与 evidence 发布绑定无效");
  }
}

function removeUniqueOperationArtifact(directory, artifactPath, expected) {
  const current = readOptionalOperationLockSnapshot(artifactPath, { allowPartial: expected.record == null });
  if (!current
    || !sameOperationLockIdentity(current.identity, expected.identity)
    || !current.raw.equals(expected.raw)
    || (expected.record && !sameOperationLockLease(current.record, expected.record))) {
    operationLockChanged(artifactPath);
  }
  fs.unlinkSync(artifactPath);
}

async function invokeOperationLockFault(options, point, context) {
  await options.operationLockHooks?.faultInjector?.(point, context);
  maybeCrash(point);
}

function operationLockHeld(pid) {
  throw migrationError("MIGRATION_OPERATION_LOCKED", `另一个记忆重整命令仍持有操作锁（PID ${pid}）`);
}

function operationLockInvalid(message) {
  throw migrationError("MIGRATION_OPERATION_LOCK_INVALID", message);
}

function operationLockIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameOperationLockIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameOptionalOperationLockSnapshot(left, right) {
  if (!left || !right) return left === right;
  return sameOperationLockIdentity(left.identity, right.identity)
    && left.raw.equals(right.raw)
    && sameOperationLockFileSnapshot(left.stat, right.stat);
}

function sameOperationLockFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function noFollowOpenFlag() {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function operationLockChanged(filePath) {
  throw migrationError("MIGRATION_OPERATION_LOCK_CHANGED", `迁移操作锁读取期间发生变化：${filePath}`);
}

function isOperationLockRace(error) {
  return error?.code === "MIGRATION_OPERATION_LOCK_CHANGED" || error?.code === "ENOENT";
}

function maybeCrash(point) {
  const fault = process.env.SUNABOT_MEMORY_MIGRATION_FAULT;
  if (fault === `throw:${point}`) throw migrationError("FAULT_INJECTED", `fault at ${point}`);
  if (fault === `sigkill:${point}`) process.kill(process.pid, "SIGKILL");
}

async function assertOffline(
  workspace,
  confirmed,
  portProbe = portIsOpen,
  handleProbe = databaseHasOpenHandles,
  definitionsOverride,
  options = {}
) {
  const definitions = await assertStoppedHandlesAndPaths(
    workspace,
    confirmed,
    portProbe,
    handleProbe,
    definitionsOverride,
    options
  );
  await options.beforeDatabaseOpen?.({ workspace, definitions });
  const locks = [];
  try {
    for (const definition of definitions) {
      for (const relative of [definition.application, definition.queue]) {
        const databasePath = safeWorkspaceChild(workspace, relative);
        if (fileState(databasePath) === "missing" && options.allowMissingCurrent) continue;
        assertNoSymlinkPath(workspace, databasePath);
        if (fileState(databasePath) !== "file") {
          throw migrationError("DATABASE_PATH_INVALID", `${relative} 必须是非 symlink 普通文件`);
        }
        options.databaseOpenObserver?.({
          databasePath: path.resolve(databasePath),
          scope: "offline-live",
          blocked: false
        });
        const database = openMigrationDatabase(databasePath, { timeout: 500 });
        locks.push(database);
        database.exec("PRAGMA busy_timeout=500; BEGIN EXCLUSIVE");
      }
    }
  } catch (error) {
    throw migrationError("DATABASE_NOT_QUIESCED", `无法独占锁定全部 Agent application/queue：${error.message}`);
  } finally {
    for (const database of locks.reverse()) {
      try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      database.close();
    }
  }
  checkpointAndClearSidecars(workspace, definitions, { allowMissing: options.allowMissingCurrent });
}

async function assertStoppedHandlesAndPaths(
  workspace,
  confirmed,
  portProbe = portIsOpen,
  handleProbe = databaseHasOpenHandles,
  definitionsOverride,
  options = {}
) {
  if (confirmed !== true) throw migrationError("QUIESCENCE_REQUIRED", "写模式必须显式提供 --quiesced");
  for (const port of [8787, 8788]) {
    if (await portProbe(port)) throw migrationError("CORE_STILL_RUNNING", `127.0.0.1:${port} 仍在监听`);
  }
  const definitions = definitionsOverride ?? discoverDatabasePairs(workspace);
  for (const definition of definitions) {
    for (const relative of [definition.application, definition.queue]) {
      const databasePath = safeWorkspaceChild(workspace, relative);
      if (fileState(databasePath) === "missing" && options.allowMissingCurrent) {
        assertNoSymlinkPath(workspace, databasePath, { allowMissing: true });
        for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
          const state = fileState(sidecar);
          if (state === "missing") continue;
          if (state !== "file") throw migrationError("SQLITE_SIDECAR_INVALID", `${sidecar} 类型异常`);
          assertNoSymlinkPath(workspace, sidecar);
          if (await handleProbe(sidecar)) {
            throw migrationError("DATABASE_HANDLE_OPEN", `${workspaceRelative(workspace, sidecar)} 仍被进程持有`);
          }
        }
        continue;
      }
      assertNoSymlinkPath(workspace, databasePath);
      if (fileState(databasePath) !== "file") {
        throw migrationError("DATABASE_PATH_INVALID", `${relative} 必须是非 symlink 普通文件`);
      }
      for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (candidate !== databasePath) {
          const state = fileState(candidate);
          if (state === "missing") continue;
          if (state !== "file") throw migrationError("SQLITE_SIDECAR_INVALID", `${candidate} 类型异常`);
          assertNoSymlinkPath(workspace, candidate);
        }
        if (await handleProbe(candidate)) {
          throw migrationError("DATABASE_HANDLE_OPEN", `${workspaceRelative(workspace, candidate)} 仍被进程持有`);
        }
      }
    }
  }
  return definitions;
}

function checkpointAndClearSidecars(workspace, definitions, options = {}) {
  for (const definition of definitions) {
    for (const relative of [definition.application, definition.queue]) {
      const databasePath = safeWorkspaceChild(workspace, relative);
      if (fileState(databasePath) === "missing" && options.allowMissing) {
        for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
          const state = fileState(sidecar);
          if (state === "file") fs.rmSync(sidecar);
          else if (state !== "missing") throw migrationError("SQLITE_SIDECAR_INVALID", `${sidecar} 类型异常`);
        }
        const databaseDirectory = path.dirname(databasePath);
        syncDirectory(fileState(databaseDirectory) === "directory"
          ? databaseDirectory
          : path.dirname(databaseDirectory));
        continue;
      }
      const database = openMigrationDatabase(databasePath, { timeout: 1_000 });
      try {
        const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        if (result && Number(result.busy ?? 0) !== 0) {
          throw migrationError("SQLITE_CHECKPOINT_BUSY", `${relative} wal_checkpoint(TRUNCATE) busy`);
        }
      } finally {
        database.close();
      }
      const wal = `${databasePath}-wal`;
      const shm = `${databasePath}-shm`;
      if (fileState(wal) === "file" && fs.statSync(wal).size !== 0) {
        throw migrationError("SQLITE_WAL_NOT_EMPTY", `${relative}-wal 在停服 checkpoint 后仍非空`);
      }
      for (const sidecar of [wal, shm]) {
        const state = fileState(sidecar);
        if (state === "file") fs.rmSync(sidecar);
        else if (state !== "missing") throw migrationError("SQLITE_SIDECAR_INVALID", `${sidecar} 类型异常`);
      }
      syncDirectory(path.dirname(databasePath));
    }
  }
}

function databaseHasOpenHandles(databasePath) {
  const result = spawnSync("lsof", [databasePath], { encoding: "utf8" });
  if (result.error) throw migrationError("LSOF_UNAVAILABLE", `无法执行 lsof：${result.error.message}`);
  if (![0, 1].includes(result.status)) throw migrationError("LSOF_FAILED", `lsof 失败：${result.stderr || result.stdout}`);
  return result.status === 0 && Boolean(result.stdout.trim());
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(150);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function parseArguments(argv) {
  const [command = "help", ...rest] = argv;
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw migrationError("ARGUMENT_INVALID", `无法识别参数：${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) flags.add(name);
    else {
      values.set(name, next);
      index += 1;
    }
  }
  return { command, values, flags };
}

function requiredValue(values, name) {
  const value = values.get(name);
  if (!value) throw migrationError("ARGUMENT_REQUIRED", `缺少 --${name} PATH`);
  return value;
}

function usage() {
  return `用法：
  memory-perspective-v1.mjs export --workspace PATH --output WORKSPACE_JSON
  memory-perspective-v1.mjs generate --export FILE --proposal-dir WORKSPACE_DIR
  memory-perspective-v1.mjs sign --proposal-dir WORKSPACE_DIR
  memory-perspective-v1.mjs refresh --workspace PATH --proposal-dir DIR --plan-dir DIR
  memory-perspective-v1.mjs dry-run --workspace PATH --plan-dir DIR
  memory-perspective-v1.mjs prepare --workspace PATH --plan-dir DIR --quiesced [--backup RECOVERY_POINT]
  memory-perspective-v1.mjs apply --workspace PATH --plan-dir DIR --backup RECOVERY_POINT --staging-workspace EMPTY_PATH --quiesced
  memory-perspective-v1.mjs install --workspace PATH --staging-workspace PATH --quiesced --confirm-replace
  memory-perspective-v1.mjs verify --workspace PATH --plan-dir DIR [--report FILE] --quiesced
  memory-perspective-v1.mjs rollback --workspace PATH --backup RECOVERY_POINT --target-workspace EMPTY_PATH --quiesced
  memory-perspective-v1.mjs abort --workspace PATH --quiesced

export/generate/refresh/dry-run 不写 SQLite。prepare 先写 durable intent，再创建并绑定恢复点；apply 只修改空 staging，install 才按可重入 data 目录 journal 切换。`;
}

function resolveWorkspace(input) {
  const resolved = path.resolve(String(input));
  if (fileState(resolved) !== "directory") throw migrationError("WORKSPACE_INVALID", `workspace 不存在或不是目录：${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw migrationError("SYMLINK_FORBIDDEN", "workspace 不能是符号链接");
  return fs.realpathSync(resolved);
}

function inferWorkspaceFromExport(exportFile) {
  return inferWorkspaceFromArtifact(exportFile, "export 文件");
}

function inferWorkspaceFromArtifact(artifact, label) {
  let current = fileState(artifact) === "directory" ? artifact : path.dirname(artifact);
  while (true) {
    if (fileState(path.join(current, "business")) === "directory") return resolveWorkspace(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw migrationError("ARTIFACT_WORKSPACE_UNKNOWN", `${label} 必须位于其 workspace 内`);
}

function assertRelativeJsonArtifactPath(input, label) {
  const normalized = normalizeRelativePath(input);
  if (normalized !== String(input).replaceAll("\\", "/") || !normalized.endsWith(".json")) {
    throw migrationError("ARTIFACT_PATH_INVALID", `${label} 必须是 workspace 内的规范相对 JSON 路径`);
  }
  return normalized;
}

function assertSha256(input, code, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(input ?? ""))) {
    throw migrationError(code, `${label} 不是有效 SHA-256`);
  }
}

function assertAllowedObjectKeys(value, allowed, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError(code, `${label} 必须是 object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw migrationError(code, `${label} 含未知字段：${unknown.join(", ")}`);
}

function assertExactObjectKeys(value, expected, code, label) {
  assertAllowedObjectKeys(value, new Set(expected), code, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (stableJson(actual) !== stableJson(required)) {
    throw migrationError(code, `${label} 必须严格包含：${required.join(", ")}`);
  }
}

function assertNoAbsoluteArtifactPaths(value, label, segments = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...segments, key];
    if (typeof child === "string" && /(?:path|directory|file)$/i.test(key) && path.isAbsolute(child)) {
      throw migrationError("ARTIFACT_PATH_ABSOLUTE", `${label}.${next.join(".")} 不得保留绝对路径`);
    }
    if (child && typeof child === "object") assertNoAbsoluteArtifactPaths(child, label, next);
  }
}

function resolveWorkspaceOutput(workspace, input, label) {
  const raw = path.isAbsolute(String(input)) ? path.resolve(String(input)) : path.resolve(workspace, String(input));
  const resolved = canonicalizeMissingPath(raw);
  if (!isInside(workspace, resolved)) throw migrationError("OUTPUT_PATH_UNSAFE", `${label} 必须位于 workspace 内`);
  assertNoSymlinkPath(workspace, path.dirname(resolved), { allowMissing: true });
  return resolved;
}

function canonicalizeMissingPath(input) {
  const suffix = [];
  let current = path.resolve(input);
  while (fileState(current) === "missing") {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const base = fileState(current) === "missing" ? current : fs.realpathSync(current);
  return path.join(base, ...suffix);
}

function resolveWorkspaceInput(workspace, input, label) {
  const resolved = path.isAbsolute(String(input)) ? path.resolve(String(input)) : path.resolve(workspace, String(input));
  if (!isInside(workspace, resolved)) throw migrationError("INPUT_PATH_UNSAFE", `${label} 必须位于 workspace 内`);
  if (fileState(resolved) === "missing") throw migrationError("INPUT_MISSING", `${label} 不存在：${resolved}`);
  assertNoSymlinkPath(workspace, resolved);
  return resolved;
}

function resolveExistingFile(input, label) {
  const resolved = path.resolve(String(input));
  if (fileState(resolved) !== "file") throw migrationError("INPUT_MISSING", `${label} 不是普通文件：${resolved}`);
  if (fs.lstatSync(resolved).isSymbolicLink()) throw migrationError("SYMLINK_FORBIDDEN", `${label} 不能是符号链接`);
  return resolved;
}

function resolveExistingDirectory(input, label) {
  const resolved = path.resolve(String(input));
  if (fileState(resolved) !== "directory") throw migrationError("INPUT_MISSING", `${label} 不是目录：${resolved}`);
  if (fs.lstatSync(resolved).isSymbolicLink()) throw migrationError("SYMLINK_FORBIDDEN", `${label} 不能是符号链接`);
  return resolved;
}

function safeWorkspaceChild(workspace, relative) {
  const normalized = normalizeRelativePath(relative);
  const absolute = path.resolve(workspace, normalized);
  if (!isInside(workspace, absolute)) throw migrationError("PATH_TRAVERSAL", `路径越界：${relative}`);
  return absolute;
}

function normalizeRelativePath(input) {
  const value = String(input ?? "").replaceAll("\\", "/");
  const normalized = path.posix.normalize(value);
  if (!value || path.posix.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    throw migrationError("RELATIVE_PATH_INVALID", `必须使用安全相对路径：${value}`);
  }
  return normalized;
}

function assertRelativeDatabasePath(input, basename) {
  const normalized = normalizeRelativePath(input);
  if (path.posix.basename(normalized) !== basename) {
    throw migrationError("DATABASE_PATH_INVALID", `数据库路径必须以 ${basename} 结尾：${input}`);
  }
}

function assertNoSymlinkPath(root, target, options = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !isInside(resolvedRoot, resolvedTarget)) {
    throw migrationError("PATH_TRAVERSAL", `路径越界：${target}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const state = fileState(current);
    if (state === "missing") {
      if (options.allowMissing) return;
      throw migrationError("INPUT_MISSING", `路径不存在：${current}`);
    }
    if (fs.lstatSync(current).isSymbolicLink()) throw migrationError("SYMLINK_FORBIDDEN", `路径包含符号链接：${current}`);
  }
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function fileState(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function ensureEmptyOrMissingDirectory(directory) {
  const state = fileState(directory);
  if (state === "missing") return;
  if (state !== "directory") throw migrationError("OUTPUT_CONFLICT", `输出路径不是目录：${directory}`);
  const entries = fs.readdirSync(directory);
  if (entries.length) throw migrationError("OUTPUT_NOT_EMPTY", `输出目录必须为空：${directory}`);
}

function listNamedJson(directory, suffix) {
  if (fileState(directory) !== "directory") throw migrationError("INPUT_MISSING", `目录不存在：${directory}`);
  assertNoSymlinkPath(directory, directory);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) throw migrationError("SYMLINK_FORBIDDEN", `目录含符号链接：${entry.name}`);
      return entry.isFile() && entry.name.endsWith(suffix);
    })
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function validateAgentId(agentId) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(agentId ?? ""))) {
    throw migrationError("AGENT_ID_INVALID", `Agent ID 无效：${agentId}`);
  }
}

function assertTable(database, table, agentId) {
  const row = database.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name=?").get(table);
  if (!row) throw migrationError("DATABASE_SCHEMA_INVALID", `${agentId}: 缺少 ${table} 表`);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { throw migrationError("JSON_INVALID", `${filePath} 不是有效 JSON：${error.message}`); }
}

function readSignedJson(filePath, signatureField) {
  const value = readJson(filePath);
  verifyDocumentSignature(value, signatureField);
  return value;
}

function readOptionalJson(filePath) {
  return fileState(filePath) === "file" ? readJson(filePath) : null;
}

function signDocument(value, signatureField) {
  const output = structuredClone(value);
  delete output[signatureField];
  output[signatureField] = documentSha256(output, signatureField);
  return output;
}

function verifyDocumentSignature(value, signatureField) {
  const actual = normalizeText(value?.[signatureField]);
  const expected = documentSha256(value, signatureField);
  if (!actual || actual !== expected) throw migrationError("DOCUMENT_SIGNATURE_MISMATCH", `${signatureField} 不匹配`);
}

function documentSha256(value, signatureField) {
  const copy = structuredClone(value);
  delete copy[signatureField];
  return `sha256:${canonicalSha256(copy)}`;
}

function verifyIntentSignature(intent) {
  if (intent?.schemaVersion !== 1 || intent?.migrationId !== MIGRATION_ID) {
    throw migrationError("MIGRATION_INTENT_INVALID", "migration intent schema 无效");
  }
  verifyDocumentSignature(intent, "intentSha256");
}

function readRequiredIntent(intentPath) {
  const intent = readOptionalJson(intentPath);
  if (!intent) throw migrationError("MIGRATION_INTENT_MISSING", "缺少 durable migration intent，请先执行 prepare");
  verifyIntentSignature(intent);
  return intent;
}

function updateIntent(intentPath, current, patch) {
  verifyIntentSignature(current);
  const next = signDocument({ ...current, ...structuredClone(patch), updatedAt: new Date().toISOString() }, "intentSha256");
  writeJsonAtomicDurable(intentPath, next);
  return next;
}

function migrationIntentPath(workspace) {
  return path.join(workspace, "business", "migrations", `${MIGRATION_ID}-intent.json`);
}

function writeJsonAtomicDurable(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  syncDirectory(path.dirname(filePath));
}

function syncFile(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function canonicalSha256(value) {
  return crypto.createHash("sha256").update(stableJson(canonicalize(value))).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw migrationError("NON_FINITE_NUMBER", "签名数据包含非有限数字");
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $base64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  throw migrationError("CANONICAL_VALUE_INVALID", `无法签名的数据类型：${typeof value}`);
}

function summarizeFact(data) {
  return normalizeText(data?.fact ?? data?.value ?? data?.text ?? data?.content ?? "").slice(0, 240) || "（无可读正文）";
}

function emptyMetadataPatch() {
  return { preserveFromBase: [], set: {}, remove: [] };
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeNullable(value) {
  return value == null ? null : String(value);
}

function normalizeUserIds(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return unique(values.map((item) => normalizeText(item)).filter(Boolean));
}

function normalizeUserIdsStrict(value, context) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return [];
  const normalized = [];
  for (const item of values) {
    const text = typeof item === "number" && Number.isSafeInteger(item) ? String(item) : typeof item === "string" ? item.trim() : "";
    if (!/^\d{5,20}$/.test(text)) throw migrationError("TARGET_USER_IDS_INVALID", `${context} 含无效 QQ userId`);
    normalized.push(text);
  }
  return unique(normalized);
}

function normalizeProfileUserId(value, context) {
  const type = typeof value;
  const normalized = type === "number" && Number.isSafeInteger(value)
    ? String(value)
    : type === "string" ? value.trim() : "";
  if (!/^\d{5,20}$/.test(normalized)) throw migrationError("PROFILE_USER_ID_INVALID", `${context} 缺少有效 userId`);
  return { normalized, type };
}

function normalizeRequiredUserName(value, context) {
  const userName = normalizeText(value);
  if (!userName || /^(?:QQ(?:号)?\s*[:：#]?\s*)?\d{5,20}$/i.test(userName)) {
    throw migrationError("TARGET_USER_NAME_INVALID", `${context} 缺少非 QQ 的有效昵称`);
  }
  return userName;
}

function naturalMemoryIdentityPattern(userId, userName = "") {
  const namePattern = userName
    ? escapeRegExp(userName)
    : "(?!(?:与|和|及|跟|同|、)\\s*[（(])[^，。！？；：（）()\\r\\n]{1,40}";
  return new RegExp(`${namePattern}\\s*[（(]\\s*QQ(?:号)?\\s*[:：#]?\\s*${escapeRegExp(userId)}(?!\\d)\\s*[）)]`, "i");
}

function hasNaturalMemoryIdentity(fact, userId, userName) {
  return findNaturalMemoryIdentityMatch(fact, userId, userName) != null;
}

function findNaturalMemoryIdentityMatch(fact, userId, userName) {
  const text = String(fact);
  for (const marker of text.matchAll(naturalMemoryIdentityMarkerPattern(userId))) {
    const match = naturalMemoryIdentityAtMarker(text, marker, userName);
    if (match) return match;
  }
  return undefined;
}

function hasOnlyTrustedNaturalMemoryIdentities(fact, userId, trustedNames) {
  const text = String(fact);
  let markerCount = 0;
  for (const marker of text.matchAll(naturalMemoryIdentityMarkerPattern(userId))) {
    markerCount += 1;
    if (!trustedNames.some((userName) => naturalMemoryIdentityAtMarker(text, marker, userName))) {
      return false;
    }
  }
  return markerCount > 0;
}

function naturalMemoryIdentityMarkerPattern(userId) {
  return new RegExp(
    `[（(]\\s*QQ(?:号)?\\s*[:：#]?\\s*${escapeRegExp(userId)}(?!\\d)\\s*[）)]`,
    "gu"
  );
}

function naturalMemoryIdentityMarkerUserIds(fact) {
  return [...String(fact).matchAll(/[（(]\s*QQ(?:号)?\s*[:：#]?\s*(\d{5,20})(?!\d)\s*[）)]/giu)]
    .map((match) => match[1]);
}

function naturalMemoryIdentityAtMarker(fact, marker, userName) {
  const markerStart = marker.index;
  const beforeMarker = fact.slice(0, markerStart).replace(/\s+$/u, "");
  if (!beforeMarker.endsWith(userName)) return undefined;
  const identityStart = beforeMarker.length - userName.length;
  const leftContext = beforeMarker.slice(0, identityStart);
  if (!hasNaturalMemoryIdentityLeftBoundary(leftContext)) return undefined;
  return {
    start: identityStart,
    end: markerStart + marker[0].length
  };
}

function hasNaturalMemoryIdentityLeftBoundary(leftContext) {
  if (!leftContext) return true;
  if (/[\s,，.。!！?？;；:：、"'“”‘’「」『』\[\]【】({（]$/u.test(leftContext)) return true;
  return /(?:认为|觉得|知道|了解|了解到|注意到|意识到|理解|相信|判断|看出|发现|在意|担心|期待|欣赏|认可|重视|愿意|乐意|支持|感谢|关心|关注|尊重|喜欢|信任|帮助|陪伴|保护|告诉|听到|看到|得知|提到|关于|涉及|对|和|与)$/u.test(leftContext);
}

function roleCognitionPrefix(fact) {
  return fact.match(/^(?:我(?:也)?(?:觉得|认为|判断|意识到|理解|相信|推测|在意|希望|担心|期待|认可|反感|偏好|看重|知道|了解到|注意到|看出|发现|欣赏|重视|愿意|乐意|对)|I\s+(?:think|believe|judge|understand|realize|know|notice|prefer|care|hope|worry|expect)\b)/i)?.[0] ?? "";
}

function hasAmbiguousUserFirstPersonSubject(fact, userIds, userName) {
  const prefix = roleCognitionPrefix(fact);
  if (!prefix) return false;
  if (/["'“‘「『]\s*(?:我(?:自己|本人)?|I\b)/iu.test(fact)) return true;
  const matches = userIds.flatMap((userId) => {
    const match = findNaturalMemoryIdentityMatch(fact, userId, userName);
    return match ? [{ userId, ...match }] : [];
  });
  if (matches.some(({ end }) => /^(?:\s|[,，])*(?:[^。！？；;:：\r\n]{0,32})?(?:说|表示|提到|自述|回答|声称|写道|告诉我)\s*(?:[:：]\s*)?["'“‘「『]?\s*(?:我(?:自己|本人)?|I\b)/iu.test(fact.slice(end)))) {
    return true;
  }
  if (matches.some(({ end }) => /^\s*(?:就是|是)\s*我的(?:昵称|名字|姓名|身份)/u.test(fact.slice(end)))) {
    return true;
  }

  const firstIdentityStart = matches.reduce((earliest, match) => (
    earliest == null || match.start < earliest ? match.start : earliest
  ), undefined);
  const beforeIdentity = fact.slice(prefix.length, firstIdentityStart ?? fact.length).trim();
  const relationalLeading = matches.some(({ start }) => (
    /^我(?:自己|本人)?(?:和|与|对)\s*$/u.test(fact.slice(prefix.length, start).trim())
  ));
  if (relationalLeading) return false;
  return /^(?:我(?:自己|本人)?|自己|本人)/u.test(beforeIdentity)
    || /(?:我的|自己|本人)/u.test(beforeIdentity);
}

function stripQuotedSpeech(value) {
  return String(value)
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, "");
}

function roleProfilePerspectivePattern(userName, userId) {
  const cognition = "(?:认为|觉得|知道|了解到|注意到|意识到|理解|相信|判断|看出|发现|在意|担心|期待|欣赏|认可|重视|愿意|乐意|对)";
  const identity = `${escapeRegExp(userName)}\\s*[（(]\\s*QQ(?:号)?\\s*[:：#]?\\s*${escapeRegExp(userId)}(?!\\d)\\s*[）)]`;
  return new RegExp(`^我(?:也)?${cognition}[\\s\\S]{0,120}${identity}`, "u");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values)];
}

function computeEventFingerprint(fact, userIds, occurredAt, occurredEndAt) {
  return `sha256:${canonicalSha256({
    fact: normalizeText(fact).normalize("NFKC").toLowerCase().replace(/\s+/g, " "),
    userIds: [...normalizeUserIds(userIds)].sort(),
    occurredAt: normalizeIso(occurredAt) || null,
    occurredEndAt: normalizeIso(occurredEndAt) || null
  })}`;
}

function computeEventKey(eventTypeInput, subjectKeyInput, userIdsInput) {
  const eventType = normalizeText(eventTypeInput).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const subjectKey = normalizeText(subjectKeyInput).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").slice(0, 512);
  const userIds = [...normalizeUserIds(userIdsInput)].sort();
  if (!eventType || !subjectKey) return "";
  return `v1:sha256:${canonicalSha256({ eventType, subjectKey, userIds })}`;
}

function normalizeIso(value) {
  const text = normalizeText(value);
  const timestamp = Date.parse(text);
  return text && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function workspaceRelative(workspace, filePath) {
  return path.relative(workspace, path.resolve(filePath)).replaceAll(path.sep, "/");
}

function installCommand(workspace, stagingWorkspace) {
  return `node tooling/migrations/${MIGRATION_ID}.mjs install --workspace ${shellQuote(workspace)} --staging-workspace ${shellQuote(stagingWorkspace)} --quiesced --confirm-replace`;
}

function rollbackCommand(workspace, backupPath, targetWorkspace = `${workspace}-${MIGRATION_ID}-rollback`) {
  return `node tooling/migrations/${MIGRATION_ID}.mjs rollback --workspace ${shellQuote(workspace)} --backup ${shellQuote(backupPath)} --target-workspace ${shellQuote(targetWorkspace)} --quiesced`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function migrationError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export {
  assertRowsEqualReplacements,
  databaseLogicalSha256,
  validateMemoryFact,
  validateReplacements
};
