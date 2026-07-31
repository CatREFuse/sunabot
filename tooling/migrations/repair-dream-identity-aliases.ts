#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeMemoryEventFingerprint } from "../../services/memory/domain/normalizers.js";
import { listAccountRuntimeProcesses } from "../runtime/account-runtime-daemon.mjs";
import { workspaceIdentity } from "../runtime/launcher-core.mjs";
import { listNativeCoreProcessGroups } from "../runtime/native-core-process.mjs";
import { verifyRecoveryPoint } from "../workspace/sqlite-recovery.mjs";

const MIGRATION_ID = "dream-identity-alias-repair-c810-v1";
const TARGET_AGENT_ID = "arona";
const TARGET_RUN_ID = "c810a3fa-3422-46fc-a2b9-d5b6938fe476";
const TARGET_LOCAL_DATE = "2026-07-31";
const TARGET_RECORD_IDS = [
  "long_term_9b4c7b2df5c0c18e2967855b0fb5b0c2",
  "long_term_098cdf1f3f3dc989950dd47329d8c0d9",
  "long_term_ce5008d11b33e0b1e41c075e3a7a0532"
] as const;
const TARGET_SOURCE_IDS = [
  [
    "long_term_c5d272fecb51d14020da37059b197833",
    "long_term_ac2a56335036310202a9287e9e5b2baa",
    "long_term_899743c1eab14b9ad24c2e4811862dd4",
    "long_term_6ee509b20382a936cba0d9b67a485d02",
    TARGET_RECORD_IDS[0]
  ],
  [
    "long_term_8269a2a3401244053c9c9aa5ee902ff3",
    "long_term_d6c6eeb012183660f31b0b18672189ff",
    TARGET_RECORD_IDS[1]
  ],
  [
    TARGET_RECORD_IDS[2],
    "long_term_f235fb5252c9437b3808e022fbab936f"
  ]
] as const;
const ALIAS_24_PATTERN = /人物-[a-f0-9]{24}(?![a-f0-9])/gu;
const ALIAS_10_PATTERN = /人物-[a-f0-9]{10}(?![a-f0-9])/gu;
const EXPECTED_ALIAS_COUNTS = {
  uniqueInputTokens: 63,
  input: 429,
  output: 12,
  dreamText: 1,
  memory: 5,
  global: 447
} as const;
const COMMITTED_REPAIR_ERROR_CODE =
  "DREAM_IDENTITY_ALIAS_REPAIR_COMMITTED_RESTORE_REQUIRED";
const COMMITTED_REPAIR_GUIDANCE =
  "修复已提交但提交后校验未完成；必须使用 rollbackRecoveryPointId 对应的恢复点恢复，禁止重跑 apply。";
const GENERIC_REPAIR_ERROR_CODE = "DREAM_IDENTITY_ALIAS_REPAIR_FAILED";
const GENERIC_REPAIR_ERROR_MESSAGE = "Dream 身份别名修复失败。";
const REPAIR_ERROR_MARKER = Symbol("dreamIdentityAliasRepairError");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ACCOUNT_RUNTIME_ENTRY = path.join(
  PROJECT_ROOT,
  "tooling/runtime/account-runtime-daemon.mjs"
);

type JsonObject = Record<string, unknown>;

interface DreamRunRow {
  id: string;
  local_date: string;
  status: string;
  worker_id: string | null;
  lease_until: string | null;
  attempt_count: number;
  seed: string;
  input_digest: string;
  input_json: string;
  output_json: string | null;
  dream_text: string | null;
  persona_json: string | null;
  persona_status: string;
  result_json: string | null;
  error_code: string | null;
  next_retry_at: string | null;
}

interface MemoryRow {
  source: string;
  position: number;
  record_id: string;
  data_json: string;
}

interface VerifiedRecovery {
  directory: string;
  recoveryPointId: string;
  createdAt: string;
  applicationDatabasePath: string;
  databases: RecoveryDatabase[];
  identityBinding: RecoveryPointIdentityBinding;
}

interface RecoveryDatabase {
  id: string;
  agentId: string;
  kind: "application" | "session_queue";
  source: string;
  databasePath: string;
  expectedBytes: number;
  expectedSha256: string;
}

interface DirectoryIdentity {
  path: string;
  identity: string;
}

interface DirectoryEntryIdentity {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  identity: string;
}

interface SqliteFileIdentity {
  path: string;
  identity: string;
  nlink: number;
  size: number;
}

interface SqlitePathIdentitySnapshot {
  directoryChain: DirectoryIdentity[];
  parentDirectoryEntriesDigest: string;
  main: SqliteFileIdentity;
  wal: SqliteFileIdentity | null;
  shm: SqliteFileIdentity | null;
}

interface ApplicationIdentityGuard {
  directoryChain: DirectoryIdentity[];
  parentDirectoryEntriesDigest: string;
  main: SqliteFileIdentity;
  wal: SqliteFileIdentity | null;
  shm: SqliteFileIdentity | null;
  connectionMainFileDescriptor: number | null;
  connectionWalFileDescriptor: number | null;
  connectionShmFileDescriptor: number | null;
}

interface OpenFileDescriptorIdentity {
  fileDescriptor: number;
  identity: string;
  nlink: number;
}

interface RecoveryFileIdentity extends SqliteFileIdentity {
  sha256: string;
}

interface RecoveryPointIdentityBinding {
  code: string;
  directoryChain: DirectoryIdentity[];
  directoryEntriesDigest: string;
  stableDirectoryEntriesDigest: string;
  databaseFilePaths: string[];
  sidecarFilePaths: string[];
  files: RecoveryFileIdentity[];
}

interface VerifiedRecoveryDatabaseSidecars {
  databasePath: string;
  wal: RecoveryFileIdentity | null;
  shm: RecoveryFileIdentity | null;
}

interface RecoveryVerificationSnapshot {
  identity: RecoveryPointIdentityBinding;
  manifestBytes: Buffer;
  checksumBytes: Buffer;
  manifest: JsonObject;
}

interface RecoveryVerifierResult {
  directory: string;
  manifest: {
    recoveryPointId?: unknown;
    createdAt?: unknown;
    consistency?: { mode?: unknown; checkpoint?: unknown; lock?: unknown };
    databases?: Array<{
      id?: unknown;
      agentId?: unknown;
      kind?: unknown;
      source?: unknown;
      file?: unknown;
      bytes?: unknown;
      sha256?: unknown;
    }>;
  };
}

interface WorkspaceDatabaseBindingEntry {
  id: string;
  agentId: string;
  kind: "application" | "session_queue";
  source: string;
  currentDatabasePath: string;
  rollbackLogicalDigest: string;
  currentLogicalDigest: string;
}

interface WorkspaceDatabaseBinding {
  workspace: string;
  digest: string;
  entries: WorkspaceDatabaseBindingEntry[];
  recoveryIdentity: RecoveryPointIdentityBinding;
}

interface PrivateMapping {
  replacements: Map<string, string>;
  digest: string;
  uniqueTokens: number;
  numericIds: number;
  displayTexts: number;
  minimumChars: number;
  maximumChars: number;
}

interface FileSnapshot {
  workingMemorySha256: string;
  queueFileSetSha256: string;
}

interface PreparedRepair {
  workspace: string;
  databasePath: string;
  queuePath: string;
  workingMemoryPath: string;
  recovery: VerifiedRecovery;
  mapping: PrivateMapping;
  runBefore: DreamRunRow;
  runAfter: DreamRunRow;
  recordsBefore: MemoryRow[];
  recordsAfter: MemoryRow[];
  tableCounts: Record<string, number>;
  revisions: Record<string, number>;
  fileSnapshot: FileSnapshot;
  legacy10Occurrences: number;
  publicInspection: DreamIdentityAliasRepairInspection;
}

export interface DreamIdentityAliasRepairInput {
  workspace: string;
  agentId: string;
  runId: string;
  recoveryPoint: string;
  recoveryPointId: string;
}

export interface DreamIdentityAliasRepairApplyInput extends DreamIdentityAliasRepairInput {
  rollbackRecoveryPoint: string;
  rollbackRecoveryPointId: string;
  expectedMappingDigest: string;
  quiesced: boolean;
  serviceProbe?: DreamIdentityAliasRepairServiceProbe;
  faultInjector?: (point:
    | "before-write-open"
    | "after-write-open"
    | "after-rollback-verify"
    | "before-begin"
    | "after-begin"
    | "after-memory-updates"
    | "before-commit"
    | "after-commit-exec"
    | "after-commit"
    | "before-checkpoint"
    | "after-checkpoint"
  ) => void | Promise<void>;
  rollbackVerifyDatabaseClosedObserver?: (event: {
    databasePath: string;
    id: string;
  }) => void | Promise<void>;
  commitExecutor?: (database: DatabaseSync) => void;
}

export interface DreamIdentityAliasRepairServiceProbe {
  isPortOpen(port: number): Promise<boolean>;
  runningHostProcesses(workspace: string): Promise<string[]>;
  runningContainers(workspace: string): Promise<string[]>;
}

export interface DreamIdentityAliasRepairInspection {
  migrationId: typeof MIGRATION_ID;
  mode: "dry-run";
  agentId: typeof TARGET_AGENT_ID;
  runId: typeof TARGET_RUN_ID;
  recoveryPointId: string;
  mapping: {
    digest: string;
    uniqueTokens: number;
    uniquelyResolved: number;
    unresolved: number;
    ambiguous: number;
    numericIds: number;
    displayTexts: number;
    minimumChars: number;
    maximumChars: number;
  };
  aliases: {
    inputOccurrences: number;
    outputOccurrences: number;
    dreamTextOccurrences: number;
    memoryOccurrences: number;
    global24HexOccurrences: number;
    legacy10HexOccurrences: number;
  };
  hashes: {
    inputJson: HashChange;
    inputDigest: HashChange;
    outputJson: HashChange;
    dreamText: HashChange;
    personaJson: HashChange;
    resultJson: HashChange;
    workingMemorySha256: string;
    queueFileSetSha256: string;
  };
  records: Array<{
    recordId: string;
    reviewIndex: number;
    position: number;
    canonicalMatches: boolean;
    sourceIds: string[];
    dataJson: HashChange;
    fingerprintChanges: boolean;
  }>;
  counts: Record<string, number>;
  revisions: Record<string, number>;
  gates: {
    currentMatchesMappingRecovery: true;
    inputDigestValid: true;
    integrity: "ok";
    foreignKeyViolations: 0;
  };
}

interface HashChange {
  beforeSha256: string | null;
  afterSha256: string | null;
}

export async function inspectDreamIdentityAliasRepair(
  input: DreamIdentityAliasRepairInput
): Promise<DreamIdentityAliasRepairInspection> {
  try {
    return (await prepareRepair(input)).publicInspection;
  } catch (error) {
    throw sanitizeRepairFailure(error);
  }
}

export async function applyDreamIdentityAliasRepair(input: DreamIdentityAliasRepairApplyInput) {
  try {
    return await applyDreamIdentityAliasRepairInternal(input);
  } catch (error) {
    throw sanitizeRepairFailure(error);
  }
}

async function applyDreamIdentityAliasRepairInternal(input: DreamIdentityAliasRepairApplyInput) {
  assertApplyInput(input);
  const workspace = await resolveWorkspace(input.workspace);
  await assertServicesStopped(workspace, input.quiesced, input.serviceProbe ?? defaultServiceProbe);
  const prepared = await prepareRepair({ ...input, workspace });
  if (input.expectedMappingDigest !== prepared.mapping.digest) {
    throw repairError("MAPPING_DIGEST_MISMATCH", "映射摘要与 dry-run 结果不一致。");
  }
  const rollback = await verifyExplicitRecoveryPoint({
    workspace,
    agentId: input.agentId,
    recoveryPoint: input.rollbackRecoveryPoint,
    recoveryPointId: input.rollbackRecoveryPointId,
    identityChangeCode: "ROLLBACK_RECOVERY_POINT_CHANGED",
    initialDatabaseClosedObserver: input.rollbackVerifyDatabaseClosedObserver,
    afterVerify: () => input.faultInjector?.("after-rollback-verify")
  });
  assertNewRollbackRecovery(prepared.recovery, rollback);
  const rollbackBinding = await bindRollbackRecoveryToWorkspace(prepared, rollback);
  await assertServicesStopped(workspace, input.quiesced, input.serviceProbe ?? defaultServiceProbe);
  await assertFileSnapshot(prepared);
  await assertWorkspaceDatabaseBinding(rollbackBinding);

  const applicationIdentity = await createApplicationIdentityGuard(prepared.databasePath);
  await input.faultInjector?.("before-write-open");
  const descriptorsBeforeOpen = captureOpenFileDescriptors();
  const database = new DatabaseSync(prepared.databasePath, { timeout: 5_000 });
  const descriptorsAfterOpen = captureOpenFileDescriptors();
  let transactionOpen = false;
  let commitAttempted = false;
  try {
    await input.faultInjector?.("after-write-open");
    bindApplicationOpenIdentity(
      applicationIdentity,
      descriptorsBeforeOpen,
      descriptorsAfterOpen
    );
    assertOpenDatabaseLocation(database, prepared.databasePath);
    await assertApplicationIdentity(applicationIdentity, false);
    await input.faultInjector?.("before-begin");
    const descriptorsBeforeBegin = captureOpenFileDescriptors();
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
    transactionOpen = true;
    const descriptorsAfterBegin = captureOpenFileDescriptors();
    await input.faultInjector?.("after-begin");
    const openedApplicationIdentity = await captureSqlitePathIdentity(
      prepared.databasePath,
      false,
      "APPLICATION_FILE_UNSAFE"
    );
    bindApplicationSidecarOpenIdentity(
      applicationIdentity,
      descriptorsBeforeBegin,
      descriptorsAfterBegin,
      openedApplicationIdentity
    );
    await assertApplicationIdentity(applicationIdentity);
    assertTargetDatabaseLogicalBinding(database, rollbackBinding, prepared.databasePath);
    assertDatabasePreconditions(database, prepared);

    const updateMemory = database.prepare(`
      UPDATE memory_records
      SET data_json = ?
      WHERE source = 'long_term'
        AND position = ?
        AND record_id = ?
        AND data_json = ?
    `);
    let updatedMemoryRecords = 0;
    for (let index = 0; index < prepared.recordsBefore.length; index += 1) {
      const before = prepared.recordsBefore[index]!;
      const after = prepared.recordsAfter[index]!;
      const result = updateMemory.run(
        after.data_json,
        before.position,
        before.record_id,
        before.data_json
      );
      if (Number(result.changes) !== 1) {
        throw repairError("MEMORY_PRECONDITION_CHANGED", "目标长期记忆在事务开始前发生变化。");
      }
      updatedMemoryRecords += Number(result.changes);
    }
    await input.faultInjector?.("after-memory-updates");
    await assertApplicationIdentity(applicationIdentity);

    const runResult = database.prepare(`
      UPDATE dream_runs
      SET input_digest = ?,
          input_json = ?,
          output_json = ?,
          dream_text = ?,
          persona_json = ?,
          result_json = ?
      WHERE id = ?
        AND local_date = ?
        AND status = 'completed'
        AND worker_id IS NULL
        AND lease_until IS NULL
        AND attempt_count = 1
        AND seed = ?
        AND input_digest = ?
        AND input_json = ?
        AND output_json IS ?
        AND dream_text IS ?
        AND persona_json IS ?
        AND persona_status = ?
        AND result_json IS ?
        AND error_code IS NULL
        AND next_retry_at IS NULL
    `).run(
      prepared.runAfter.input_digest,
      prepared.runAfter.input_json,
      prepared.runAfter.output_json,
      prepared.runAfter.dream_text,
      prepared.runAfter.persona_json,
      prepared.runAfter.result_json,
      prepared.runBefore.id,
      prepared.runBefore.local_date,
      prepared.runBefore.seed,
      prepared.runBefore.input_digest,
      prepared.runBefore.input_json,
      prepared.runBefore.output_json,
      prepared.runBefore.dream_text,
      prepared.runBefore.persona_json,
      prepared.runBefore.persona_status,
      prepared.runBefore.result_json
    );
    if (Number(runResult.changes) !== 1) {
      throw repairError("DREAM_RUN_PRECONDITION_CHANGED", "目标 Dream run 在事务开始前发生变化。");
    }

    const post = assertDatabasePostconditions(database, prepared);
    const postRepairLogicalDigest = logicalDatabaseDigest(database);
    await input.faultInjector?.("before-commit");
    await assertWorkspaceDatabaseBinding(rollbackBinding, prepared.databasePath);
    await assertApplicationIdentity(applicationIdentity);
    await assertFileSnapshot(prepared);
    commitAttempted = true;
    (input.commitExecutor ?? defaultCommitExecutor)(database);
    await input.faultInjector?.("after-commit-exec");
    transactionOpen = false;

    await input.faultInjector?.("after-commit");
    await assertApplicationIdentity(applicationIdentity);
    await input.faultInjector?.("before-checkpoint");
    await assertApplicationIdentity(applicationIdentity);
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    };
    if (Number(checkpoint.busy) !== 0) {
      throw repairError("WAL_CHECKPOINT_BUSY", "修复已提交，但 WAL checkpoint 未能收敛。");
    }
    await input.faultInjector?.("after-checkpoint");
    await assertApplicationIdentity(applicationIdentity);
    const finalPost = assertDatabasePostconditions(database, prepared);
    if (logicalDatabaseDigest(database) !== postRepairLogicalDigest
      || !sameRecord(finalPost.revisionDelta, post.revisionDelta)
      || finalPost.global24HexOccurrences !== post.global24HexOccurrences
      || finalPost.legacy10HexOccurrences !== post.legacy10HexOccurrences) {
      throw repairError(
        "POST_COMMIT_APPLICATION_CHANGED",
        "目标 application DB 在提交后偏离事务内修复结果。"
      );
    }
    const finalIntegrity = integrityStatus(database);
    const finalForeignKeys = foreignKeyViolations(database);
    if (finalIntegrity !== "ok" || finalForeignKeys !== 0) {
      throw repairError("POST_COMMIT_DATABASE_INVALID", "修复提交后的 SQLite 校验失败。");
    }
    await assertWorkspaceDatabaseBinding(rollbackBinding, prepared.databasePath);
    await assertFileSnapshot(prepared);
    return {
      migrationId: MIGRATION_ID,
      applied: true,
      agentId: TARGET_AGENT_ID,
      runId: TARGET_RUN_ID,
      mappingDigest: prepared.mapping.digest,
      rollbackRecoveryPointId: rollback.recoveryPointId,
      rollbackWorkspaceLogicalDigest: rollbackBinding.digest,
      updatedMemoryRecords,
      updatedDreamRuns: Number(runResult.changes),
      global24HexOccurrences: post.global24HexOccurrences,
      legacy10HexOccurrences: post.legacy10HexOccurrences,
      integrity: finalIntegrity,
      foreignKeyViolations: finalForeignKeys,
      revisionDelta: post.revisionDelta,
      countsPreserved: true,
      workingMemoryUnchanged: true,
      queueUnchanged: true,
      checkpoint: {
        busy: Number(checkpoint.busy),
        log: Number(checkpoint.log),
        checkpointed: Number(checkpoint.checkpointed)
      }
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; the verified recovery point remains bound for operator recovery.
      }
    }
    if (commitAttempted) throw committedRepairError(rollback.recoveryPointId);
    throw error;
  } finally {
    try {
      database.close();
    } catch (error) {
      if (commitAttempted) throw committedRepairError(rollback.recoveryPointId);
      throw error;
    }
  }
}

function defaultCommitExecutor(database: DatabaseSync) {
  database.exec("COMMIT");
}

async function prepareRepair(input: DreamIdentityAliasRepairInput): Promise<PreparedRepair> {
  assertTargetInput(input);
  const workspace = await resolveWorkspace(input.workspace);
  const paths = await resolveAgentPaths(workspace, input.agentId);
  const recovery = await verifyExplicitRecoveryPoint({
    workspace,
    agentId: input.agentId,
    recoveryPoint: input.recoveryPoint,
    recoveryPointId: input.recoveryPointId
  });
  const recoveryDatabase = openImmutableDatabase(recovery.applicationDatabasePath);
  let recoveryRun: DreamRunRow;
  let recoveryRecords: MemoryRow[];
  let mapping: PrivateMapping;
  try {
    recoveryRun = readTargetRun(recoveryDatabase);
    recoveryRecords = readTargetRecords(recoveryDatabase);
    assertTargetRunShape(recoveryRun);
    assertTargetRecordsShape(recoveryRecords);
    mapping = reconstructMapping(recoveryDatabase, recoveryRun);
  } finally {
    recoveryDatabase.close();
  }

  const currentDatabaseIdentity = await captureSqlitePathIdentity(
    paths.databasePath,
    true,
    "APPLICATION_FILE_UNSAFE"
  );
  const database = openImmutableDatabase(paths.databasePath);
  try {
    const runBefore = readTargetRun(database);
    const recordsBefore = readTargetRecords(database);
    assertTargetRunShape(runBefore);
    assertTargetRecordsShape(recordsBefore);
    assertCurrentMatchesRecovery(runBefore, recordsBefore, recoveryRun, recoveryRecords);
    const aliases = aliasCounts(database, runBefore, recordsBefore);
    assertExpectedAliasCounts(aliases, mapping);
    const tableCounts = databaseTableCounts(database);
    const revisions = memoryRevisions(database);
    const integrity = integrityStatus(database);
    const foreignKeys = foreignKeyViolations(database);
    if (integrity !== "ok" || foreignKeys !== 0) {
      throw repairError("CURRENT_DATABASE_INVALID", "当前 Agent 数据库未通过 SQLite 完整性校验。");
    }
    const repaired = buildRepairedRows(runBefore, recordsBefore, mapping);
    const fileSnapshot = await snapshotExternalFiles(paths.workingMemoryPath, paths.queuePath);
    const publicInspection = buildPublicInspection({
      recovery,
      mapping,
      runBefore,
      runAfter: repaired.run,
      recordsBefore,
      recordsAfter: repaired.records,
      aliases,
      tableCounts,
      revisions,
      fileSnapshot
    });
    await assertSqlitePathIdentity(currentDatabaseIdentity, "APPLICATION_FILE_IDENTITY_CHANGED");
    return {
      workspace,
      ...paths,
      recovery,
      mapping,
      runBefore,
      runAfter: repaired.run,
      recordsBefore,
      recordsAfter: repaired.records,
      tableCounts,
      revisions,
      fileSnapshot,
      legacy10Occurrences: aliases.legacy10,
      publicInspection
    };
  } finally {
    database.close();
  }
}

function reconstructMapping(database: DatabaseSync, run: DreamRunRow): PrivateMapping {
  const tokens = uniqueMatches(run.input_json, ALIAS_24_PATTERN);
  if (tokens.length !== EXPECTED_ALIAS_COUNTS.uniqueInputTokens) {
    throw repairError("ALIAS_TOKEN_SET_INVALID", "目标 Dream input 的 24-hex token 数量不符合定向合同。");
  }
  const candidates = structuredIdentityCandidates(database);
  const replacements = new Map<string, string>();
  for (const token of tokens) {
    const values = new Set(candidates
      .filter((candidate) => identityAliasToken(run.seed, candidate) === token));
    if (values.size === 0) {
      throw repairError("ALIAS_IDENTITY_UNRESOLVED", "存在无法从恢复点唯一恢复的身份 token。");
    }
    if (values.size !== 1) {
      throw repairError("ALIAS_IDENTITY_AMBIGUOUS", "存在对应多个恢复点身份值的 token。");
    }
    const value = [...values][0]!;
    if (ALIAS_24_PATTERN.test(value) || ALIAS_10_PATTERN.test(value)) {
      throw repairError("ALIAS_IDENTITY_INVALID", "恢复点身份候选仍包含别名 token。");
    }
    replacements.set(token, value);
  }
  const entries = [...replacements].sort(([left], [right]) => left.localeCompare(right));
  const lengths = entries.map(([, value]) => [...value].length);
  return {
    replacements,
    digest: sha256(JSON.stringify(entries.map(([token, value]) => ({
      token,
      valueSha256: sha256(value)
    })))),
    uniqueTokens: entries.length,
    numericIds: entries.filter(([, value]) => /^\d+$/u.test(value)).length,
    displayTexts: entries.filter(([, value]) => !/^\d+$/u.test(value)).length,
    minimumChars: Math.min(...lengths),
    maximumChars: Math.max(...lengths)
  };
}

function structuredIdentityCandidates(database: DatabaseSync) {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string" && typeof item !== "number") continue;
      const normalized = [...String(item).normalize("NFC").trim()].slice(0, 256).join("");
      if (normalized) candidates.add(normalized);
    }
  };
  const identityFields = [
    "userId", "userIds", "userName", "addressName", "addressNames",
    "senderName", "senderNickname", "senderCard"
  ];
  for (const row of database.prepare("SELECT data_json FROM memory_records").all() as Array<{
    data_json: string;
  }>) {
    const record = parseJsonObject(row.data_json, "RECOVERY_MEMORY_INVALID");
    for (const field of identityFields) if (field in record) add(record[field]);
  }
  for (const row of database.prepare("SELECT data_json FROM conversations").all() as Array<{
    data_json: string;
  }>) {
    const conversation = parseJsonObject(row.data_json, "RECOVERY_CONVERSATION_INVALID");
    for (const message of arrayObjects(conversation.messages)) {
      for (const field of identityFields) if (field in message) add(message[field]);
    }
  }
  for (const row of database.prepare("SELECT targets_json FROM scheduled_tasks").all() as Array<{
    targets_json: string;
  }>) {
    for (const target of arrayObjects(parseJson(row.targets_json, "RECOVERY_TASK_INVALID"))) {
      if ("mentionUserIds" in target) add(target.mentionUserIds);
    }
  }
  for (const row of database.prepare("SELECT schedule_json FROM director_daily_schedules").all() as Array<{
    schedule_json: string;
  }>) {
    const schedule = parseJsonObject(row.schedule_json, "RECOVERY_SCHEDULE_INVALID");
    for (const item of arrayObjects(schedule.items)) {
      if ("participants" in item) add(item.participants);
    }
  }
  for (const row of database.prepare("SELECT id, name FROM agents").all() as Array<{
    id: string;
    name: string;
  }>) {
    add(row.id);
    add(row.name);
  }
  return [...candidates];
}

function buildRepairedRows(
  runBefore: DreamRunRow,
  recordsBefore: MemoryRow[],
  mapping: PrivateMapping
) {
  const input = replaceJsonValue(parseJsonObject(runBefore.input_json, "DREAM_INPUT_INVALID"), mapping);
  const outputBefore = parseJsonObject(requiredText(runBefore.output_json, "DREAM_OUTPUT_INVALID"), "DREAM_OUTPUT_INVALID");
  const rawOutputBefore = parseJsonObject(
    requiredText(outputBefore.rawOutput, "DREAM_RAW_OUTPUT_INVALID"),
    "DREAM_RAW_OUTPUT_INVALID"
  );
  const output = replaceJsonValue(outputBefore, mapping) as JsonObject;
  output.rawOutput = JSON.stringify(replaceJsonValue(rawOutputBefore, mapping));
  const persona = runBefore.persona_json == null
    ? null
    : replaceJsonValue(parseJsonObject(runBefore.persona_json, "DREAM_PERSONA_INVALID"), mapping);
  const result = runBefore.result_json == null
    ? null
    : replaceJsonValue(parseJsonObject(runBefore.result_json, "DREAM_RESULT_INVALID"), mapping);
  const dreamText = replaceText(requiredText(runBefore.dream_text, "DREAM_TEXT_INVALID"), mapping);
  const inputJson = JSON.stringify(input);
  const outputJson = JSON.stringify(output);
  const personaJson = persona == null ? null : JSON.stringify(persona);
  const resultJson = result == null ? null : JSON.stringify(result);
  const runAfter = {
    ...runBefore,
    input_digest: canonicalJsonDigest(input),
    input_json: inputJson,
    output_json: outputJson,
    dream_text: dreamText,
    persona_json: personaJson,
    result_json: resultJson
  };
  const recordsAfter = recordsBefore.map((row) => {
    const data = replaceJsonValue(parseJsonObject(row.data_json, "MEMORY_RECORD_INVALID"), mapping) as JsonObject;
    data.eventFingerprint = computeMemoryEventFingerprint({
      fact: data.fact,
      userIds: data.userIds,
      occurredAt: data.occurredAt,
      occurredEndAt: data.occurredEndAt
    });
    return { ...row, data_json: JSON.stringify(data) };
  });
  assertRepairedSemantics(runAfter, recordsAfter);
  return { run: runAfter, records: recordsAfter };
}

function assertRepairedSemantics(run: DreamRunRow, records: MemoryRow[]) {
  const values = [
    run.input_json,
    run.output_json ?? "",
    run.dream_text ?? "",
    run.persona_json ?? "",
    run.result_json ?? "",
    ...records.map((record) => record.data_json)
  ];
  if (values.some((value) => countMatches(value, ALIAS_24_PATTERN) !== 0)) {
    throw repairError("ALIAS_REPAIR_INCOMPLETE", "预计算结果仍包含 24-hex 身份 token。");
  }
  if (run.input_digest !== canonicalJsonDigest(parseJson(run.input_json, "DREAM_INPUT_INVALID"))) {
    throw repairError("INPUT_DIGEST_INVALID", "预计算 Dream input digest 不一致。");
  }
  const output = parseJsonObject(requiredText(run.output_json, "DREAM_OUTPUT_INVALID"), "DREAM_OUTPUT_INVALID");
  const dream = objectValue(output.dream);
  if (run.dream_text !== dream.text) {
    throw repairError("DREAM_TEXT_MISMATCH", "Dream text 与结构化 output 不一致。");
  }
  parseJsonObject(requiredText(output.rawOutput, "DREAM_RAW_OUTPUT_INVALID"), "DREAM_RAW_OUTPUT_INVALID");
  const reviews = arrayObjects(output.longTermReviews);
  records.forEach((row, reviewIndex) => {
    const data = parseJsonObject(row.data_json, "MEMORY_RECORD_INVALID");
    const review = reviews[reviewIndex];
    if (data.fact !== objectValue(review?.canonical).fact) {
      throw repairError("CANONICAL_FACT_MISMATCH", "长期记忆与 Dream canonical 不一致。");
    }
    const expectedFingerprint = computeMemoryEventFingerprint({
      fact: data.fact,
      userIds: data.userIds,
      occurredAt: data.occurredAt,
      occurredEndAt: data.occurredEndAt
    });
    if (data.eventFingerprint !== expectedFingerprint) {
      throw repairError("EVENT_FINGERPRINT_MISMATCH", "长期记忆 fingerprint 不一致。");
    }
  });
}

function assertDatabasePreconditions(database: DatabaseSync, prepared: PreparedRepair) {
  const run = readTargetRun(database);
  const records = readTargetRecords(database);
  assertCurrentMatchesRecovery(
    run,
    records,
    prepared.runBefore,
    prepared.recordsBefore
  );
  if (!sameRecord(databaseTableCounts(database), prepared.tableCounts)) {
    throw repairError("TABLE_COUNTS_CHANGED", "数据库表记录数在 dry-run 后发生变化。");
  }
  if (!sameRecord(memoryRevisions(database), prepared.revisions)) {
    throw repairError("MEMORY_REVISION_CHANGED", "记忆 revision 在 dry-run 后发生变化。");
  }
  if (integrityStatus(database) !== "ok" || foreignKeyViolations(database) !== 0) {
    throw repairError("CURRENT_DATABASE_INVALID", "事务前 SQLite 校验失败。");
  }
}

function assertDatabasePostconditions(database: DatabaseSync, prepared: PreparedRepair) {
  const run = readTargetRun(database);
  const records = readTargetRecords(database);
  assertCurrentMatchesRecovery(run, records, prepared.runAfter, prepared.recordsAfter);
  assertRepairedSemantics(run, records);
  const counts = databaseTableCounts(database);
  if (!sameRecord(counts, prepared.tableCounts)) {
    throw repairError("TABLE_COUNTS_CHANGED", "修复改变了数据库表记录数。");
  }
  const revisions = memoryRevisions(database);
  const revisionDelta = {
    long_term: (revisions.long_term ?? 0) - (prepared.revisions.long_term ?? 0),
    user_profile: (revisions.user_profile ?? 0) - (prepared.revisions.user_profile ?? 0),
    working: (revisions.working ?? 0) - (prepared.revisions.working ?? 0)
  };
  if (!sameRecord(revisionDelta, { long_term: 3, user_profile: 0, working: 0 })) {
    throw repairError("MEMORY_REVISION_INVALID", "修复后的记忆 revision 增量不符合合同。");
  }
  const global24HexOccurrences = globalAliasCount(database, ALIAS_24_PATTERN);
  const legacy10HexOccurrences = globalAliasCount(database, ALIAS_10_PATTERN);
  if (global24HexOccurrences !== 0) {
    throw repairError("GLOBAL_ALIAS_REMAINS", "修复后仍存在 24-hex 身份 token。");
  }
  if (legacy10HexOccurrences !== prepared.legacy10Occurrences) {
    throw repairError("LEGACY_ALIAS_CHANGED", "定向修复不得改变 10-hex 历史别名。");
  }
  if (integrityStatus(database) !== "ok" || foreignKeyViolations(database) !== 0) {
    throw repairError("POST_REPAIR_DATABASE_INVALID", "事务内 SQLite 校验失败。");
  }
  return { global24HexOccurrences, legacy10HexOccurrences, revisionDelta };
}

async function bindRollbackRecoveryToWorkspace(
  prepared: PreparedRepair,
  rollback: VerifiedRecovery
): Promise<WorkspaceDatabaseBinding> {
  await assertRecoveryPointIdentity(rollback.identityBinding);
  const expectedSources = rollback.databases.map((entry) => entry.source).sort();
  const currentSources = await listCurrentWorkspaceDatabaseSources(prepared.workspace);
  if (JSON.stringify(expectedSources) !== JSON.stringify(currentSources)) {
    throw repairError(
      "ROLLBACK_RECOVERY_POINT_STALE",
      "回滚恢复点与当前 workspace 的数据库集合不一致。"
    );
  }
  const entries: WorkspaceDatabaseBindingEntry[] = [];
  for (const recoveryDatabase of [...rollback.databases].sort(
    (left, right) => left.source.localeCompare(right.source)
  )) {
    const currentDatabasePath = resolveWorkspaceDatabaseSource(
      prepared.workspace,
      recoveryDatabase.source
    );
    const rollbackLogicalDigest = await stableLogicalDatabaseDigest(
      recoveryDatabase.databasePath,
      "ROLLBACK_DATABASE_FILE_UNSAFE"
    );
    const currentLogicalDigest = await stableLogicalDatabaseDigest(
      currentDatabasePath,
      "CURRENT_DATABASE_FILE_UNSAFE"
    );
    if (rollbackLogicalDigest !== currentLogicalDigest) {
      throw repairError(
        "ROLLBACK_RECOVERY_POINT_STALE",
        "回滚恢复点与当前 quiesced workspace 的逻辑数据不一致。"
      );
    }
    entries.push({
      id: recoveryDatabase.id,
      agentId: recoveryDatabase.agentId,
      kind: recoveryDatabase.kind,
      source: recoveryDatabase.source,
      currentDatabasePath,
      rollbackLogicalDigest,
      currentLogicalDigest
    });
  }
  await assertRecoveryPointIdentity(rollback.identityBinding);
  return {
    workspace: prepared.workspace,
    entries,
    recoveryIdentity: rollback.identityBinding,
    digest: sha256(JSON.stringify(entries.map((entry) => ({
      id: entry.id,
      agentId: entry.agentId,
      kind: entry.kind,
      source: entry.source,
      logicalDigest: entry.currentLogicalDigest
    }))))
  };
}

async function assertWorkspaceDatabaseBinding(
  binding: WorkspaceDatabaseBinding,
  excludedDatabasePath?: string
) {
  await assertRecoveryPointIdentity(binding.recoveryIdentity);
  const expectedSources = binding.entries.map((entry) => entry.source).sort();
  const currentSources = await listCurrentWorkspaceDatabaseSources(binding.workspace);
  if (JSON.stringify(expectedSources) !== JSON.stringify(currentSources)) {
    throw repairError(
      "ROLLBACK_RECOVERY_POINT_STALE",
      "已绑定的 workspace 数据库集合在 apply 期间发生变化。"
    );
  }
  for (const entry of binding.entries) {
    if (entry.currentDatabasePath === excludedDatabasePath) continue;
    const currentLogicalDigest = await stableLogicalDatabaseDigest(
      entry.currentDatabasePath,
      "CURRENT_DATABASE_FILE_UNSAFE"
    );
    if (currentLogicalDigest !== entry.currentLogicalDigest) {
      throw repairError(
        "ROLLBACK_RECOVERY_POINT_STALE",
        "已绑定的 workspace 逻辑数据在 apply 期间发生变化。"
      );
    }
  }
}

function assertTargetDatabaseLogicalBinding(
  database: DatabaseSync,
  binding: WorkspaceDatabaseBinding,
  targetDatabasePath: string
) {
  const target = binding.entries.find(
    (entry) => entry.currentDatabasePath === targetDatabasePath
  );
  if (!target || logicalDatabaseDigest(database) !== target.currentLogicalDigest) {
    throw repairError(
      "ROLLBACK_RECOVERY_POINT_STALE",
      "目标 application DB 在事务锁定前已偏离回滚恢复点。"
    );
  }
}

async function listCurrentWorkspaceDatabaseSources(workspace: string) {
  const sources = [
    "business/data/session-queue.sqlite",
    "business/data/sunabot.sqlite"
  ];
  const agentsRoot = path.join(workspace, "business", "agents");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return sources.sort();
    throw error;
  }
  for (const entry of entries) {
    const agentRoot = path.join(agentsRoot, entry.name);
    const stat = await fs.lstat(agentRoot);
    if (stat.isSymbolicLink()) {
      throw repairError("CURRENT_DATABASE_FILE_UNSAFE", "Agent 数据目录不得是符号链接。");
    }
    if (!stat.isDirectory()) continue;
    const dataRoot = path.join(agentRoot, "data");
    const application = path.join(dataRoot, "sunabot.sqlite");
    const queue = path.join(dataRoot, "session-queue.sqlite");
    const [hasApplication, hasQueue] = await Promise.all([
      fileExists(application),
      fileExists(queue)
    ]);
    if (!hasApplication && !hasQueue) continue;
    if (!/^[a-z][a-z0-9-]{1,31}$/u.test(entry.name) || !hasApplication || !hasQueue) {
      throw repairError(
        "ROLLBACK_RECOVERY_POINT_STALE",
        "当前 workspace 存在非法或不完整的 Agent 数据库对。"
      );
    }
    sources.push(
      `business/agents/${entry.name}/data/session-queue.sqlite`,
      `business/agents/${entry.name}/data/sunabot.sqlite`
    );
  }
  return sources.sort();
}

async function fileExists(filePath: string) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function resolveWorkspaceDatabaseSource(workspace: string, source: string) {
  if (typeof source !== "string"
    || path.posix.isAbsolute(source)
    || path.posix.normalize(source) !== source
    || source.startsWith("../")
    || source.includes("\\")) {
    throw repairError("RECOVERY_POINT_INVALID", "恢复点数据库源路径无效。");
  }
  const databasePath = path.resolve(workspace, ...source.split("/"));
  const relative = path.relative(workspace, databasePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw repairError("RECOVERY_POINT_INVALID", "恢复点数据库源路径越界。");
  }
  return databasePath;
}

function assertNewRollbackRecovery(mapping: VerifiedRecovery, rollback: VerifiedRecovery) {
  if (mapping.directory === rollback.directory
    || mapping.recoveryPointId === rollback.recoveryPointId
    || Date.parse(rollback.createdAt) <= Date.parse(mapping.createdAt)) {
    throw repairError(
      "ROLLBACK_RECOVERY_POINT_NOT_NEW",
      "apply 必须绑定晚于映射恢复点的新 quiesced 恢复点。"
    );
  }
}

function openImmutableDatabase(databasePath: string) {
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("mode", "ro");
  databaseUrl.searchParams.set("immutable", "1");
  return new DatabaseSync(databaseUrl, {
    readOnly: true,
    timeout: 5_000
  });
}

async function stableLogicalDatabaseDigest(databasePath: string, unsafeCode: string) {
  const snapshot = await captureSqlitePathIdentity(databasePath, true, unsafeCode);
  const database = openImmutableDatabase(databasePath);
  let digest: string;
  try {
    digest = logicalDatabaseDigest(database);
  } finally {
    database.close();
  }
  await assertSqlitePathIdentity(snapshot, "SQLITE_FILE_IDENTITY_CHANGED");
  return digest;
}

function logicalDatabaseDigest(database: DatabaseSync) {
  const hash = crypto.createHash("sha256");
  updateLogicalHash(hash, "sunabot-sqlite-logical-v1");
  for (const pragma of ["application_id", "encoding", "user_version"]) {
    const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
    updateLogicalHash(hash, pragma);
    updateLogicalHash(hash, encodeSqliteRow(Object.values(row ?? {})));
  }
  const schema = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    ORDER BY type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY, sql COLLATE BINARY
  `);
  schema.setReturnArrays(true);
  for (const row of schema.iterate() as Iterable<unknown[]>) {
    updateLogicalHash(hash, encodeSqliteRow(row));
  }
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table'
    ORDER BY name COLLATE BINARY
  `).all() as Array<{ name: string }>;
  for (const { name: table } of tables) {
    updateLogicalHash(hash, `table:${table}`);
    const columns = database.prepare(`
      SELECT name, type, "notnull" AS not_null, dflt_value, pk, hidden
      FROM pragma_table_xinfo(?)
      ORDER BY cid
    `).all(table) as Array<{
      name: string;
      type: string;
      not_null: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>;
    updateLogicalHash(hash, JSON.stringify(columns));
    const columnProjection = columns.map((column) => quotedIdentifier(column.name)).join(", ");
    const projectedValues = columnProjection ? `, ${columnProjection}` : "";
    const shadowedNames = new Set(columns.map((column) => column.name.toLowerCase()));
    const rowIdAlias = ["rowid", "_rowid_", "oid"].find(
      (candidate) => !shadowedNames.has(candidate)
    );
    let statement: ReturnType<DatabaseSync["prepare"]> | undefined;
    if (rowIdAlias) {
      try {
        statement = database.prepare(`
          SELECT ${rowIdAlias}${projectedValues}
          FROM ${quotedIdentifier(table)}
          ORDER BY ${rowIdAlias}
        `);
      } catch {
        statement = undefined;
      }
    }
    if (!statement) {
      const primaryKey = columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk);
      if (primaryKey.length && columnProjection) {
        statement = database.prepare(`
          SELECT ${columnProjection}
          FROM ${quotedIdentifier(table)}
          ORDER BY ${primaryKey.map((column) => quotedIdentifier(column.name)).join(", ")}
        `);
      }
    }
    if (statement) {
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      let rowCount = 0;
      for (const row of statement.iterate() as Iterable<unknown[]>) {
        updateLogicalHash(hash, encodeSqliteRow(row));
        rowCount += 1;
      }
      updateLogicalHash(hash, `rows:${rowCount}`);
      continue;
    }
    if (!columnProjection) {
      updateLogicalHash(hash, "rows:0");
      continue;
    }
    const fallback = database.prepare(`
      SELECT ${columnProjection} FROM ${quotedIdentifier(table)}
    `);
    fallback.setReadBigInts(true);
    fallback.setReturnArrays(true);
    const rowDigests: string[] = [];
    for (const row of fallback.iterate() as Iterable<unknown[]>) {
      rowDigests.push(sha256(encodeSqliteRow(row)));
    }
    rowDigests.sort();
    for (const rowDigest of rowDigests) updateLogicalHash(hash, rowDigest);
    updateLogicalHash(hash, `rows:${rowDigests.length}`);
  }
  return hash.digest("hex");
}

function encodeSqliteRow(row: unknown[]) {
  return JSON.stringify(row.map((value) => {
    if (value === null) return ["null"];
    if (typeof value === "bigint") return ["integer", value.toString()];
    if (typeof value === "number") {
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleBE(value);
      return ["real", bytes.toString("hex")];
    }
    if (typeof value === "string") {
      return ["text", Buffer.from(value, "utf8").toString("base64")];
    }
    if (value instanceof Uint8Array) {
      return ["blob", Buffer.from(value).toString("base64")];
    }
    throw repairError("SQLITE_LOGICAL_DIGEST_FAILED", "SQLite 行包含不支持的值类型。");
  }));
}

function updateLogicalHash(hash: crypto.Hash, value: string) {
  const bytes = Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

async function createApplicationIdentityGuard(
  databasePath: string
): Promise<ApplicationIdentityGuard> {
  const snapshot = await captureSqlitePathIdentity(
    databasePath,
    true,
    "APPLICATION_FILE_UNSAFE"
  );
  return {
    directoryChain: snapshot.directoryChain,
    parentDirectoryEntriesDigest: snapshot.parentDirectoryEntriesDigest,
    main: snapshot.main,
    wal: snapshot.wal,
    shm: snapshot.shm,
    connectionMainFileDescriptor: null,
    connectionWalFileDescriptor: null,
    connectionShmFileDescriptor: null
  };
}

async function assertApplicationIdentity(
  guard: ApplicationIdentityGuard,
  requireSidecarDescriptors = true
) {
  assertApplicationConnectionMainIdentity(guard);
  if (requireSidecarDescriptors) assertApplicationConnectionSidecarIdentity(guard);
  const current = await captureSqlitePathIdentity(
    guard.main.path,
    false,
    "APPLICATION_FILE_UNSAFE"
  );
  if (!sameApplicationDirectoryIdentityChain(guard, current)
    || !sameFileIdentity(guard.main, current.main)) {
    throw repairError(
      "APPLICATION_FILE_IDENTITY_CHANGED",
      "application DB 或父目录身份在 apply 期间发生变化。"
    );
  }
  guard.wal = bindOrAssertSidecarIdentity(guard.wal, current.wal);
  guard.shm = bindOrAssertSidecarIdentity(guard.shm, current.shm);
  guard.directoryChain = current.directoryChain;
  guard.parentDirectoryEntriesDigest = current.parentDirectoryEntriesDigest;
}

function bindApplicationOpenIdentity(
  guard: ApplicationIdentityGuard,
  beforeOpen: Map<number, OpenFileDescriptorIdentity>,
  afterOpen: Map<number, OpenFileDescriptorIdentity>
) {
  const opened = newOpenFileDescriptors(beforeOpen, afterOpen);
  const matching = opened.filter(
    (candidate) => candidate.identity === guard.main.identity && candidate.nlink === 1
  );
  if (matching.length !== 1) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      "SQLite 写连接未唯一打开预验证的 application 主文件身份。"
    );
  }
  guard.connectionMainFileDescriptor = matching[0]!.fileDescriptor;
  assertApplicationConnectionMainIdentity(guard);
}

function bindApplicationSidecarOpenIdentity(
  guard: ApplicationIdentityGuard,
  beforeBegin: Map<number, OpenFileDescriptorIdentity>,
  afterBegin: Map<number, OpenFileDescriptorIdentity>,
  openedSnapshot: SqlitePathIdentitySnapshot
) {
  if (!sameApplicationDirectoryIdentityChain(guard, openedSnapshot)
    || !sameFileIdentity(guard.main, openedSnapshot.main)) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      "SQLite 写事务未在预验证的 application 文件集上打开。"
    );
  }
  const wal = bindOpenedSidecarPathIdentity(guard.wal, openedSnapshot.wal, "WAL");
  const shm = bindOpenedSidecarPathIdentity(guard.shm, openedSnapshot.shm, "SHM");
  const openedDescriptors = newOpenFileDescriptors(beforeBegin, afterBegin);
  guard.connectionWalFileDescriptor = uniqueOpenedFileDescriptor(
    openedDescriptors,
    wal,
    "WAL"
  );
  guard.connectionShmFileDescriptor = uniqueOpenedFileDescriptor(
    openedDescriptors,
    shm,
    "SHM"
  );
  guard.wal = wal;
  guard.shm = shm;
  guard.directoryChain = openedSnapshot.directoryChain;
  guard.parentDirectoryEntriesDigest = openedSnapshot.parentDirectoryEntriesDigest;
  assertApplicationConnectionSidecarIdentity(guard);
}

function bindOpenedSidecarPathIdentity(
  expected: SqliteFileIdentity | null,
  opened: SqliteFileIdentity | null,
  label: string
) {
  if (!opened || (expected && !sameFileIdentity(expected, opened))) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      `SQLite 写事务未在预验证的 ${label} 文件身份上打开。`
    );
  }
  return expected ?? opened;
}

function uniqueOpenedFileDescriptor(
  openedDescriptors: OpenFileDescriptorIdentity[],
  expected: SqliteFileIdentity,
  label: string
) {
  const matches = openedDescriptors.filter(
    (candidate) => candidate.identity === expected.identity && candidate.nlink === 1
  );
  if (matches.length !== 1) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      `SQLite 写事务未唯一打开预验证的 ${label} 文件身份。`
    );
  }
  return matches[0]!.fileDescriptor;
}

function newOpenFileDescriptors(
  before: Map<number, OpenFileDescriptorIdentity>,
  after: Map<number, OpenFileDescriptorIdentity>
) {
  return [...after.values()].filter((candidate) => {
    const previous = before.get(candidate.fileDescriptor);
    return !previous
      || previous.identity !== candidate.identity
      || previous.nlink !== candidate.nlink;
  });
}

function assertApplicationConnectionMainIdentity(guard: ApplicationIdentityGuard) {
  if (guard.connectionMainFileDescriptor === null) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      "SQLite 写连接主文件身份尚未绑定。"
    );
  }
  if (!fileDescriptorMatches(guard.connectionMainFileDescriptor, guard.main)) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      "SQLite 写连接主文件身份在 apply 期间发生变化。"
    );
  }
}

function assertApplicationConnectionSidecarIdentity(guard: ApplicationIdentityGuard) {
  if (guard.connectionWalFileDescriptor === null
    || guard.connectionShmFileDescriptor === null
    || guard.wal === null
    || guard.shm === null
    || !fileDescriptorMatches(guard.connectionWalFileDescriptor, guard.wal)
    || !fileDescriptorMatches(guard.connectionShmFileDescriptor, guard.shm)) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_CHANGED",
      "SQLite 写连接 WAL/SHM 文件身份在 apply 期间发生变化。"
    );
  }
}

function fileDescriptorMatches(
  fileDescriptor: number,
  expected: SqliteFileIdentity
) {
  try {
    const stat = fsSync.fstatSync(fileDescriptor);
    return stat.isFile()
      && stat.nlink === 1
      && `${stat.dev}:${stat.ino}` === expected.identity;
  } catch {
    return false;
  }
}

function captureOpenFileDescriptors() {
  const descriptorRoot = ["/dev/fd", "/proc/self/fd"].find((candidate) => {
    try {
      return fsSync.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
  if (!descriptorRoot) {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_UNAVAILABLE",
      "当前平台无法验证 SQLite 写连接的实际文件身份。"
    );
  }
  let names: string[];
  try {
    names = fsSync.readdirSync(descriptorRoot);
  } catch {
    throw repairError(
      "APPLICATION_OPEN_IDENTITY_UNAVAILABLE",
      "无法枚举当前进程的文件描述符。"
    );
  }
  const descriptors = new Map<number, OpenFileDescriptorIdentity>();
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    const fileDescriptor = Number(name);
    try {
      const stat = fsSync.fstatSync(fileDescriptor);
      if (!stat.isFile()) continue;
      descriptors.set(fileDescriptor, {
        fileDescriptor,
        identity: `${stat.dev}:${stat.ino}`,
        nlink: stat.nlink
      });
    } catch {
      // The descriptor used to enumerate the directory is already closed.
    }
  }
  return descriptors;
}

function bindOrAssertSidecarIdentity(
  expected: SqliteFileIdentity | null,
  current: SqliteFileIdentity | null
) {
  if (!expected) return current;
  if (!current || !sameFileIdentity(expected, current)) {
    throw repairError(
      "APPLICATION_FILE_IDENTITY_CHANGED",
      "application DB sidecar 身份在 apply 期间发生变化。"
    );
  }
  return expected;
}

function assertOpenDatabaseLocation(database: DatabaseSync, expectedPath: string) {
  if (path.resolve(database.location()) !== expectedPath) {
    throw repairError(
      "APPLICATION_FILE_IDENTITY_CHANGED",
      "写连接未绑定到已验证的 application DB 路径。"
    );
  }
}

async function captureSqlitePathIdentity(
  databasePath: string,
  requireQuiescedWal: boolean,
  unsafeCode: string
): Promise<SqlitePathIdentitySnapshot> {
  const resolvedPath = path.resolve(databasePath);
  if (resolvedPath !== databasePath) {
    throw repairError(unsafeCode, "SQLite 数据库路径必须是规范绝对路径。");
  }
  const directoryChain = await captureDirectoryIdentityChain(path.dirname(databasePath), unsafeCode);
  const parentDirectoryEntriesDigest = await captureSqliteParentDirectoryEntriesDigest(
    databasePath,
    unsafeCode
  );
  const main = await captureSqliteFileIdentity(databasePath, false, unsafeCode);
  const wal = await captureSqliteFileIdentity(`${databasePath}-wal`, true, unsafeCode);
  const shm = await captureSqliteFileIdentity(`${databasePath}-shm`, true, unsafeCode);
  if (!main) throw repairError(unsafeCode, "SQLite 主文件不存在。");
  if (requireQuiescedWal && wal && wal.size > 32) {
    throw repairError(
      "CURRENT_WAL_NOT_QUIESCED",
      "当前数据库仍有未收敛 WAL；请停止服务并完成 checkpoint 后重试。"
    );
  }
  return { directoryChain, parentDirectoryEntriesDigest, main, wal, shm };
}

async function captureSqliteParentDirectoryEntriesDigest(
  databasePath: string,
  unsafeCode: string
) {
  const databaseName = path.basename(databasePath);
  return captureDirectoryEntriesDigest(
    path.dirname(databasePath),
    new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`]),
    unsafeCode,
    "SQLite 父目录"
  );
}

async function captureDirectoryEntriesDigest(
  directory: string,
  excludedNames: ReadonlySet<string>,
  code: string,
  label: string
) {
  const evidence = await captureDirectoryEntriesIdentity(directory, code, label);
  return digestDirectoryEntriesIdentity(evidence, excludedNames);
}

async function captureDirectoryEntriesIdentity(
  directory: string,
  code: string,
  label: string
): Promise<DirectoryEntryIdentity[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    throw repairError(code, `${label}内容不可访问。`);
  }
  const evidence = await Promise.all(entries.map(async (entry) => {
    let stat;
    try {
      stat = await fs.lstat(path.join(directory, entry.name));
    } catch {
      throw repairError(code, `${label}条目在身份绑定期间发生变化。`);
    }
    return {
      name: entry.name,
      type: (stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other") as DirectoryEntryIdentity["type"],
      identity: `${stat.dev}:${stat.ino}`
    };
  }));
  return evidence;
}

function digestDirectoryEntriesIdentity(
  evidence: DirectoryEntryIdentity[],
  excludedNames: ReadonlySet<string>
) {
  return sha256(JSON.stringify(evidence
    .filter((entry) => !excludedNames.has(entry.name))
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.type.localeCompare(right.type))));
}

async function captureDirectoryIdentityChain(directoryPath: string, unsafeCode: string) {
  const parsed = path.parse(directoryPath);
  const relative = path.relative(parsed.root, directoryPath);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  const paths = [parsed.root];
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    paths.push(current);
  }
  const identities: DirectoryIdentity[] = [];
  for (const candidate of paths) {
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch {
      throw repairError(unsafeCode, "SQLite 父目录不可访问。");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw repairError(unsafeCode, "SQLite 父目录链必须由普通目录组成。");
    }
    const real = await fs.realpath(candidate);
    if (real !== candidate) {
      throw repairError(unsafeCode, "SQLite 父目录链不得包含链接。");
    }
    identities.push({
      path: candidate,
      identity: `${stat.dev}:${stat.ino}`
    });
  }
  return identities;
}

async function captureSqliteFileIdentity(
  filePath: string,
  optional: boolean,
  unsafeCode: string
): Promise<SqliteFileIdentity | null> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw repairError(unsafeCode, "SQLite 文件不可访问。");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw repairError(unsafeCode, "SQLite 文件与 sidecar 必须是独立普通文件。");
  }
  const real = await fs.realpath(filePath);
  if (real !== filePath) {
    throw repairError(unsafeCode, "SQLite 文件与 sidecar 不得包含链接。");
  }
  return {
    path: filePath,
    identity: `${stat.dev}:${stat.ino}`,
    nlink: stat.nlink,
    size: stat.size
  };
}

async function assertSqlitePathIdentity(
  expected: SqlitePathIdentitySnapshot,
  code: string
) {
  const current = await captureSqlitePathIdentity(expected.main.path, true, code);
  if (!sameSqliteDirectoryIdentityEvidence(expected, current)
    || !sameFullFileIdentity(expected.main, current.main)
    || !sameOptionalFullFileIdentity(expected.wal, current.wal)
    || !sameOptionalFullFileIdentity(expected.shm, current.shm)) {
    throw repairError(code, "SQLite 文件集身份在只读校验期间发生变化。");
  }
}

function sameDirectoryIdentityChain(left: DirectoryIdentity[], right: DirectoryIdentity[]) {
  if (left.length !== right.length) return false;
  return left.every((before, index) => {
    const after = right[index]!;
    return before.path === after.path
      && before.identity === after.identity;
  });
}

function sameApplicationDirectoryIdentityChain(
  expected: ApplicationIdentityGuard,
  current: SqlitePathIdentitySnapshot
) {
  return sameSqliteDirectoryIdentityEvidence(expected, current);
}

function sameSqliteDirectoryIdentityEvidence(
  expected: Pick<
    SqlitePathIdentitySnapshot,
    "directoryChain" | "parentDirectoryEntriesDigest" | "wal" | "shm"
  >,
  current: SqlitePathIdentitySnapshot
) {
  if (expected.parentDirectoryEntriesDigest !== current.parentDirectoryEntriesDigest
    || expected.directoryChain.length !== current.directoryChain.length) {
    return false;
  }
  for (let index = 0; index < expected.directoryChain.length; index += 1) {
    const before = expected.directoryChain[index]!;
    const after = current.directoryChain[index]!;
    if (before.path !== after.path || before.identity !== after.identity) return false;
  }
  return true;
}

function sameFileIdentity(left: SqliteFileIdentity, right: SqliteFileIdentity) {
  return left.path === right.path
    && left.identity === right.identity
    && left.nlink === right.nlink;
}

function sameFullFileIdentity(left: SqliteFileIdentity, right: SqliteFileIdentity) {
  return sameFileIdentity(left, right) && left.size === right.size;
}

function sameOptionalFullFileIdentity(
  left: SqliteFileIdentity | null,
  right: SqliteFileIdentity | null
) {
  return left === null ? right === null : right !== null && sameFullFileIdentity(left, right);
}

function buildPublicInspection(input: {
  recovery: VerifiedRecovery;
  mapping: PrivateMapping;
  runBefore: DreamRunRow;
  runAfter: DreamRunRow;
  recordsBefore: MemoryRow[];
  recordsAfter: MemoryRow[];
  aliases: ReturnType<typeof aliasCounts>;
  tableCounts: Record<string, number>;
  revisions: Record<string, number>;
  fileSnapshot: FileSnapshot;
}): DreamIdentityAliasRepairInspection {
  const output = parseJsonObject(requiredText(input.runBefore.output_json, "DREAM_OUTPUT_INVALID"), "DREAM_OUTPUT_INVALID");
  const reviews = arrayObjects(output.longTermReviews);
  return {
    migrationId: MIGRATION_ID,
    mode: "dry-run",
    agentId: TARGET_AGENT_ID,
    runId: TARGET_RUN_ID,
    recoveryPointId: input.recovery.recoveryPointId,
    mapping: {
      digest: input.mapping.digest,
      uniqueTokens: input.mapping.uniqueTokens,
      uniquelyResolved: input.mapping.uniqueTokens,
      unresolved: 0,
      ambiguous: 0,
      numericIds: input.mapping.numericIds,
      displayTexts: input.mapping.displayTexts,
      minimumChars: input.mapping.minimumChars,
      maximumChars: input.mapping.maximumChars
    },
    aliases: {
      inputOccurrences: input.aliases.input,
      outputOccurrences: input.aliases.output,
      dreamTextOccurrences: input.aliases.dreamText,
      memoryOccurrences: input.aliases.memory,
      global24HexOccurrences: input.aliases.global24,
      legacy10HexOccurrences: input.aliases.legacy10
    },
    hashes: {
      inputJson: hashChange(input.runBefore.input_json, input.runAfter.input_json),
      inputDigest: hashChange(input.runBefore.input_digest, input.runAfter.input_digest),
      outputJson: hashChange(input.runBefore.output_json, input.runAfter.output_json),
      dreamText: hashChange(input.runBefore.dream_text, input.runAfter.dream_text),
      personaJson: hashChange(input.runBefore.persona_json, input.runAfter.persona_json),
      resultJson: hashChange(input.runBefore.result_json, input.runAfter.result_json),
      workingMemorySha256: input.fileSnapshot.workingMemorySha256,
      queueFileSetSha256: input.fileSnapshot.queueFileSetSha256
    },
    records: input.recordsBefore.map((row, reviewIndex) => {
      const before = parseJsonObject(row.data_json, "MEMORY_RECORD_INVALID");
      const after = parseJsonObject(input.recordsAfter[reviewIndex]!.data_json, "MEMORY_RECORD_INVALID");
      return {
        recordId: row.record_id,
        reviewIndex,
        position: row.position,
        canonicalMatches: before.fact === objectValue(reviews[reviewIndex]?.canonical).fact,
        sourceIds: stringArray(reviews[reviewIndex]?.sourceIds),
        dataJson: hashChange(row.data_json, input.recordsAfter[reviewIndex]!.data_json),
        fingerprintChanges: before.eventFingerprint !== after.eventFingerprint
      };
    }),
    counts: input.tableCounts,
    revisions: input.revisions,
    gates: {
      currentMatchesMappingRecovery: true,
      inputDigestValid: true,
      integrity: "ok",
      foreignKeyViolations: 0
    }
  };
}

function aliasCounts(database: DatabaseSync, run: DreamRunRow, records: MemoryRow[]) {
  return {
    input: countMatches(run.input_json, ALIAS_24_PATTERN),
    output: countMatches(run.output_json ?? "", ALIAS_24_PATTERN),
    dreamText: countMatches(run.dream_text ?? "", ALIAS_24_PATTERN),
    memory: records.reduce((sum, row) => sum + countMatches(row.data_json, ALIAS_24_PATTERN), 0),
    global24: globalAliasCount(database, ALIAS_24_PATTERN),
    legacy10: globalAliasCount(database, ALIAS_10_PATTERN)
  };
}

function assertExpectedAliasCounts(
  aliases: ReturnType<typeof aliasCounts>,
  mapping: PrivateMapping
) {
  const actual = {
    uniqueInputTokens: mapping.uniqueTokens,
    input: aliases.input,
    output: aliases.output,
    dreamText: aliases.dreamText,
    memory: aliases.memory,
    global: aliases.global24
  };
  if (!sameRecord(actual, EXPECTED_ALIAS_COUNTS)) {
    throw repairError("ALIAS_COUNTS_INVALID", "24-hex 身份 token 数量不符合定向修复合同。");
  }
}

function globalAliasCount(database: DatabaseSync, pattern: RegExp) {
  let count = 0;
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  const tableColumns = database.prepare(`
    SELECT name FROM pragma_table_xinfo(?)
    ORDER BY cid
  `);
  for (const { name: table } of tables) {
    const columns = (tableColumns.all(table) as Array<{ name: string }>).map((row) => row.name);
    if (!columns.length) continue;
    const projection = columns.map(quotedIdentifier).join(", ");
    const statement = database.prepare(`
      SELECT ${projection} FROM ${quotedIdentifier(table)}
    `);
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") count += countMatches(value, pattern);
      }
    }
  }
  return count;
}

function quotedIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function readTargetRun(database: DatabaseSync): DreamRunRow {
  const row = database.prepare(`
    SELECT id, local_date, status, worker_id, lease_until, attempt_count,
           seed, input_digest, input_json, output_json, dream_text,
           persona_json, persona_status, result_json, error_code, next_retry_at
    FROM dream_runs WHERE id = ?
  `).get(TARGET_RUN_ID) as DreamRunRow | undefined;
  if (!row) throw repairError("TARGET_RUN_MISSING", "目标 Dream run 不存在。");
  return row;
}

function readTargetRecords(database: DatabaseSync): MemoryRow[] {
  const statement = database.prepare(`
    SELECT source, position, record_id, data_json
    FROM memory_records WHERE record_id = ?
  `);
  return TARGET_RECORD_IDS.map((recordId) => {
    const row = statement.get(recordId) as MemoryRow | undefined;
    if (!row) throw repairError("TARGET_MEMORY_MISSING", "目标长期记忆不存在。");
    return row;
  });
}

function assertTargetRunShape(run: DreamRunRow) {
  if (run.id !== TARGET_RUN_ID
    || run.local_date !== TARGET_LOCAL_DATE
    || run.status !== "completed"
    || run.worker_id !== null
    || run.lease_until !== null
    || run.attempt_count !== 1
    || !/^[a-f0-9]{64}$/u.test(run.seed)
    || run.persona_status !== "none"
    || run.error_code !== null
    || run.next_retry_at !== null) {
    throw repairError("TARGET_RUN_INVALID", "目标 Dream run 状态不符合定向合同。");
  }
  const input = parseJson(run.input_json, "DREAM_INPUT_INVALID");
  if (canonicalJsonDigest(input) !== run.input_digest) {
    throw repairError("INPUT_DIGEST_INVALID", "目标 Dream input digest 不一致。");
  }
  const output = parseJsonObject(requiredText(run.output_json, "DREAM_OUTPUT_INVALID"), "DREAM_OUTPUT_INVALID");
  const reviews = arrayObjects(output.longTermReviews);
  if (reviews.length < TARGET_RECORD_IDS.length) {
    throw repairError("TARGET_REVIEWS_INVALID", "目标 Dream long-term reviews 不完整。");
  }
  TARGET_SOURCE_IDS.forEach((expected, index) => {
    const review = reviews[index]!;
    if (review.action !== "merge"
      || JSON.stringify(stringArray(review.sourceIds)) !== JSON.stringify(expected)) {
      throw repairError("TARGET_SOURCE_IDS_INVALID", "目标 Dream sourceIds 不符合定向合同。");
    }
  });
}

function assertTargetRecordsShape(records: MemoryRow[]) {
  records.forEach((row, index) => {
    const data = parseJsonObject(row.data_json, "MEMORY_RECORD_INVALID");
    if (row.source !== "long_term"
      || row.position !== 197 + index
      || row.record_id !== TARGET_RECORD_IDS[index]
      || data.id !== row.record_id
      || data.dreamRunId !== TARGET_RUN_ID
      || data.consolidatedBy !== "sunabot.dream") {
      throw repairError("TARGET_MEMORY_INVALID", "目标长期记忆不符合定向合同。");
    }
  });
}

function assertCurrentMatchesRecovery(
  currentRun: DreamRunRow,
  currentRecords: MemoryRow[],
  expectedRun: DreamRunRow,
  expectedRecords: MemoryRow[]
) {
  const runFields: Array<keyof DreamRunRow> = [
    "id", "local_date", "status", "worker_id", "lease_until", "attempt_count",
    "seed", "input_digest", "input_json", "output_json", "dream_text",
    "persona_json", "persona_status", "result_json", "error_code", "next_retry_at"
  ];
  if (runFields.some((field) => currentRun[field] !== expectedRun[field])) {
    throw repairError("CURRENT_RUN_DIFFERS_FROM_RECOVERY", "当前 Dream run 与恢复点不一致。");
  }
  if (currentRecords.length !== expectedRecords.length
    || currentRecords.some((row, index) => {
      const expected = expectedRecords[index]!;
      return row.source !== expected.source
        || row.position !== expected.position
        || row.record_id !== expected.record_id
        || row.data_json !== expected.data_json;
    })) {
    throw repairError("CURRENT_MEMORY_DIFFERS_FROM_RECOVERY", "当前长期记忆与恢复点不一致。");
  }
}

function databaseTableCounts(database: DatabaseSync) {
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => {
    const quoted = name.replaceAll('"', '""');
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).get() as {
      count: number | bigint;
    };
    return [name, Number(row.count)];
  }));
}

function memoryRevisions(database: DatabaseSync) {
  return Object.fromEntries((database.prepare(`
    SELECT source, revision FROM memory_source_revisions ORDER BY source
  `).all() as Array<{ source: string; revision: number | bigint }>).map(
    (row) => [row.source, Number(row.revision)]
  ));
}

function integrityStatus(database: DatabaseSync) {
  const row = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown };
  return String(row.integrity_check ?? "");
}

function foreignKeyViolations(database: DatabaseSync) {
  return database.prepare("PRAGMA foreign_key_check").all().length;
}

async function captureVerifiedDatabaseSidecars(
  databasePath: string,
  code: string
): Promise<VerifiedRecoveryDatabaseSidecars> {
  return {
    databasePath,
    wal: await captureOptionalRecoveryFileIdentity(`${databasePath}-wal`, code),
    shm: await captureOptionalRecoveryFileIdentity(`${databasePath}-shm`, code)
  };
}

async function captureOptionalRecoveryFileIdentity(
  filePath: string,
  code: string
): Promise<RecoveryFileIdentity | null> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw repairError(code, "恢复点 sidecar 不可访问。");
  }
  return captureRecoveryFileIdentity(filePath, code, {});
}

function assertVerifiedDatabaseSidecarsUnchanged(
  expected: VerifiedRecoveryDatabaseSidecars[],
  current: RecoveryPointIdentityBinding
) {
  const expectedDatabasePaths = expected
    .map((binding) => binding.databasePath)
    .sort((left, right) => left.localeCompare(right));
  const expectedSidecarPaths = expected
    .flatMap((binding) => [binding.wal, binding.shm])
    .filter((file): file is RecoveryFileIdentity => file !== null)
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expectedDatabasePaths) !== JSON.stringify(current.databaseFilePaths)
    || JSON.stringify(expectedSidecarPaths) !== JSON.stringify(current.sidecarFilePaths)) {
    throw repairError(current.code, "恢复点 sidecar 集合在逐库验证后发生变化。");
  }
  for (const binding of expected) {
    for (const file of [binding.wal, binding.shm]) {
      if (!file) continue;
      const currentFile = current.files.find((candidate) => candidate.path === file.path);
      if (!currentFile || !sameRecoveryFileIdentity(file, currentFile)) {
        throw repairError(current.code, "恢复点 sidecar 在逐库验证后发生变化。");
      }
    }
  }
}

async function captureRecoveryPointIdentity(
  directory: string,
  databases: RecoveryDatabase[] | undefined,
  code: string
): Promise<RecoveryPointIdentityBinding> {
  const { databaseFilePaths, sidecarFilePaths } = await listRecoveryDatabaseFiles(
    directory,
    code
  );
  const expectedDatabaseFilePaths = databases
    ?.map((database) => database.databasePath)
    .sort((left, right) => left.localeCompare(right));
  if (expectedDatabaseFilePaths
    && JSON.stringify(expectedDatabaseFilePaths) !== JSON.stringify(databaseFilePaths)) {
    throw repairError(code, "恢复点数据库物理文件集与已验证 manifest 不一致。");
  }
  const fileSpecifications = [
    { path: path.join(directory, "manifest.json") },
    { path: path.join(directory, "manifest.sha256") },
    ...(databases
      ? databases.map((database) => ({
          path: database.databasePath,
          expectedBytes: database.expectedBytes,
          expectedSha256: database.expectedSha256
        }))
      : databaseFilePaths.map((databasePath) => ({ path: databasePath }))),
    ...sidecarFilePaths.map((sidecarPath) => ({ path: sidecarPath }))
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(fileSpecifications.map((entry) => entry.path)).size !== fileSpecifications.length) {
    throw repairError(code, "恢复点包含重复的物理文件。");
  }
  const directoryChain = await captureDirectoryIdentityChain(directory, code);
  const directoryEntries = await captureRecoveryDirectoryEntriesDigests(
    directory,
    sidecarFilePaths,
    code
  );
  const files: RecoveryFileIdentity[] = [];
  for (const specification of fileSpecifications) {
    files.push(await captureRecoveryFileIdentity(specification.path, code, specification));
  }
  const directoryEntriesAfter = await captureRecoveryDirectoryEntriesDigests(
    directory,
    sidecarFilePaths,
    code
  );
  const directoryChainAfter = await captureDirectoryIdentityChain(directory, code);
  if (!sameDirectoryIdentityChain(directoryChain, directoryChainAfter)
    || directoryEntries.directoryEntriesDigest
      !== directoryEntriesAfter.directoryEntriesDigest
    || directoryEntries.stableDirectoryEntriesDigest
      !== directoryEntriesAfter.stableDirectoryEntriesDigest) {
    throw repairError(code, "恢复点目录身份在绑定期间发生变化。");
  }
  return {
    code,
    directoryChain,
    directoryEntriesDigest: directoryEntries.directoryEntriesDigest,
    stableDirectoryEntriesDigest: directoryEntries.stableDirectoryEntriesDigest,
    databaseFilePaths,
    sidecarFilePaths,
    files
  };
}

async function captureRecoveryDirectoryEntriesDigests(
  directory: string,
  sidecarFilePaths: string[],
  code: string
) {
  const evidence = await captureDirectoryEntriesIdentity(directory, code, "恢复点目录");
  return {
    directoryEntriesDigest: digestDirectoryEntriesIdentity(evidence, new Set()),
    stableDirectoryEntriesDigest: digestDirectoryEntriesIdentity(
      evidence,
      new Set(sidecarFilePaths.map((filePath) => path.basename(filePath)))
    )
  };
}

async function listRecoveryDatabaseFiles(directory: string, code: string) {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    throw repairError(code, "无法枚举恢复点数据库文件集。");
  }
  const databaseNames = entries
    .filter((entry) => entry.name.endsWith(".sqlite"))
    .map((entry) => entry.name);
  const databaseNameSet = new Set(databaseNames);
  const databaseFilePaths: string[] = [];
  const sidecarFilePaths: string[] = [];
  for (const entry of entries) {
    const isDatabase = databaseNameSet.has(entry.name);
    const isSidecar = [...databaseNameSet].some(
      (databaseName) =>
        entry.name === `${databaseName}-wal` || entry.name === `${databaseName}-shm`
    );
    if (!isDatabase && !isSidecar) {
      if (entry.name.includes(".sqlite-")) {
        throw repairError(code, "恢复点包含无法归属的 SQLite sidecar。");
      }
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw repairError(code, "恢复点数据库文件集包含非普通文件。");
    }
    (isDatabase ? databaseFilePaths : sidecarFilePaths).push(
      path.join(directory, entry.name)
    );
  }
  databaseFilePaths.sort((left, right) => left.localeCompare(right));
  sidecarFilePaths.sort((left, right) => left.localeCompare(right));
  if (!databaseFilePaths.length) {
    throw repairError(code, "恢复点数据库文件集为空。");
  }
  return { databaseFilePaths, sidecarFilePaths };
}

async function captureRecoveryVerificationSnapshot(
  directory: string,
  code: string
): Promise<RecoveryVerificationSnapshot> {
  const identity = await captureRecoveryPointIdentity(directory, undefined, code);
  const manifestIdentity = identity.files.find(
    (file) => file.path === path.join(directory, "manifest.json")
  );
  const checksumIdentity = identity.files.find(
    (file) => file.path === path.join(directory, "manifest.sha256")
  );
  if (!manifestIdentity || !checksumIdentity) {
    throw repairError(code, "恢复点 manifest 物理绑定不完整。");
  }
  const manifestBytes = await readBoundRecoveryFileBytes(manifestIdentity, code);
  const checksumBytes = await readBoundRecoveryFileBytes(checksumIdentity, code);
  let manifest: JsonObject;
  try {
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest shape");
    }
    manifest = parsed as JsonObject;
  } catch {
    throw repairError(code, "恢复点 manifest 快照不是有效 object。");
  }
  const checksumMatch = /^([a-f0-9]{64})\s+manifest\.json\s*$/iu.exec(
    checksumBytes.toString("utf8")
  );
  if (!checksumMatch || checksumMatch[1]!.toLowerCase() !== sha256(manifestBytes)) {
    throw repairError(code, "恢复点 manifest 与 checksum 快照不一致。");
  }
  return { identity, manifestBytes, checksumBytes, manifest };
}

async function readBoundRecoveryFileBytes(
  expected: RecoveryFileIdentity,
  code: string
) {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(expected.path);
  } catch {
    throw repairError(code, "恢复点 metadata 文件不可访问。");
  }
  if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
    throw repairError(code, "恢复点 metadata 内容与物理绑定不一致。");
  }
  const current = await captureRecoveryFileIdentity(expected.path, code, {
    expectedBytes: expected.size,
    expectedSha256: expected.sha256
  });
  if (!sameRecoveryFileIdentity(expected, current)) {
    throw repairError(code, "恢复点 metadata 身份在读取期间发生变化。");
  }
  return bytes;
}

function assertVerifiedRecoverySnapshot(input: {
  snapshot: RecoveryVerificationSnapshot;
  manifest: JsonObject;
  recoveryPointId: string;
  databases: RecoveryDatabase[];
  code: string;
}) {
  if (JSON.stringify(input.snapshot.manifest) !== JSON.stringify(input.manifest)
    || input.snapshot.manifest.recoveryPointId !== input.recoveryPointId) {
    throw repairError(input.code, "verify 使用的 manifest 与物理绑定快照不一致。");
  }
  const expectedDatabasePaths = input.databases
    .map((database) => database.databasePath)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(input.snapshot.identity.databaseFilePaths)
    !== JSON.stringify(expectedDatabasePaths)) {
    throw repairError(input.code, "verify 使用的数据库文件集与物理绑定快照不一致。");
  }
  for (const database of input.databases) {
    const file = input.snapshot.identity.files.find(
      (candidate) => candidate.path === database.databasePath
    );
    if (!file
      || file.size !== database.expectedBytes
      || file.sha256 !== database.expectedSha256) {
      throw repairError(input.code, "verify 使用的数据库内容与物理绑定快照不一致。");
    }
  }
}

function assertRecoveryVerificationIdentityUnchanged(
  expected: RecoveryPointIdentityBinding,
  current: RecoveryPointIdentityBinding
) {
  if (!sameDirectoryIdentityChain(expected.directoryChain, current.directoryChain)) {
    throw repairError(current.code, "恢复点目录链在 verify 与物理绑定之间发生变化。");
  }
  if (expected.stableDirectoryEntriesDigest !== current.stableDirectoryEntriesDigest
    || JSON.stringify(expected.databaseFilePaths) !== JSON.stringify(current.databaseFilePaths)
    || !verifiedRecoverySidecarSetIsExpected(expected, current)) {
    throw repairError(current.code, "恢复点文件集在 verify 与物理绑定之间发生变化。");
  }
  const coreFilePaths = new Set([
    ...expected.databaseFilePaths,
    ...expected.files
      .map((file) => file.path)
      .filter((filePath) =>
        filePath.endsWith("manifest.json") || filePath.endsWith("manifest.sha256"))
  ]);
  for (const expectedFile of expected.files) {
    if (!coreFilePaths.has(expectedFile.path)) continue;
    const currentFile = current.files.find((file) => file.path === expectedFile.path);
    if (!currentFile || !sameRecoveryFileIdentity(expectedFile, currentFile)) {
      throw repairError(current.code, "恢复点文件在 verify 与物理绑定之间发生变化。");
    }
  }
}

function assertRecoveryPointIdentityBindingUnchanged(
  expected: RecoveryPointIdentityBinding,
  current: RecoveryPointIdentityBinding
) {
  if (!sameDirectoryIdentityChain(expected.directoryChain, current.directoryChain)
    || expected.directoryEntriesDigest !== current.directoryEntriesDigest
    || expected.stableDirectoryEntriesDigest !== current.stableDirectoryEntriesDigest
    || JSON.stringify(expected.databaseFilePaths) !== JSON.stringify(current.databaseFilePaths)
    || JSON.stringify(expected.sidecarFilePaths) !== JSON.stringify(current.sidecarFilePaths)
    || expected.files.length !== current.files.length) {
    throw repairError(current.code, "恢复点物理绑定在 verify 后发生变化。");
  }
  for (const expectedFile of expected.files) {
    const currentFile = current.files.find((file) => file.path === expectedFile.path);
    if (!currentFile || !sameRecoveryFileIdentity(expectedFile, currentFile)) {
      throw repairError(current.code, "恢复点文件在 verify 后发生变化。");
    }
  }
}

function verifiedRecoverySidecarSetIsExpected(
  before: RecoveryPointIdentityBinding,
  after: RecoveryPointIdentityBinding
) {
  if (JSON.stringify(before.sidecarFilePaths) === JSON.stringify(after.sidecarFilePaths)) {
    return true;
  }
  const completeSidecarSet = before.databaseFilePaths
    .flatMap((databasePath) => [`${databasePath}-shm`, `${databasePath}-wal`])
    .sort((left, right) => left.localeCompare(right));
  return JSON.stringify(after.sidecarFilePaths) === JSON.stringify(completeSidecarSet);
}

async function assertRecoveryPointIdentity(binding: RecoveryPointIdentityBinding) {
  const directory = binding.directoryChain.at(-1)?.path;
  if (!directory) {
    throw repairError(binding.code, "恢复点目录身份绑定不完整。");
  }
  const directoryChain = await captureDirectoryIdentityChain(directory, binding.code);
  if (!sameDirectoryIdentityChain(binding.directoryChain, directoryChain)) {
    throw repairError(binding.code, "恢复点目录身份在 apply 期间发生变化。");
  }
  const { databaseFilePaths, sidecarFilePaths } = await listRecoveryDatabaseFiles(
    directory,
    binding.code
  );
  const directoryEntries = await captureRecoveryDirectoryEntriesDigests(
    directory,
    sidecarFilePaths,
    binding.code
  );
  if (JSON.stringify(binding.databaseFilePaths) !== JSON.stringify(databaseFilePaths)
    || JSON.stringify(binding.sidecarFilePaths) !== JSON.stringify(sidecarFilePaths)
    || binding.directoryEntriesDigest !== directoryEntries.directoryEntriesDigest
    || binding.stableDirectoryEntriesDigest
      !== directoryEntries.stableDirectoryEntriesDigest) {
    throw repairError(binding.code, "恢复点数据库物理文件集在 apply 期间发生变化。");
  }
  for (const expected of binding.files) {
    const current = await captureRecoveryFileIdentity(expected.path, binding.code, {
      expectedBytes: expected.size,
      expectedSha256: expected.sha256
    });
    if (!sameRecoveryFileIdentity(expected, current)) {
      throw repairError(binding.code, "恢复点文件身份在 apply 期间发生变化。");
    }
  }
  const directoryChainAfter = await captureDirectoryIdentityChain(directory, binding.code);
  const directoryEntriesAfter = await captureRecoveryDirectoryEntriesDigests(
    directory,
    sidecarFilePaths,
    binding.code
  );
  if (!sameDirectoryIdentityChain(binding.directoryChain, directoryChainAfter)
    || binding.directoryEntriesDigest !== directoryEntriesAfter.directoryEntriesDigest
    || binding.stableDirectoryEntriesDigest
      !== directoryEntriesAfter.stableDirectoryEntriesDigest) {
    throw repairError(binding.code, "恢复点目录身份在 apply 期间发生变化。");
  }
}

async function captureRecoveryFileIdentity(
  filePath: string,
  code: string,
  expected: { expectedBytes?: number; expectedSha256?: string }
): Promise<RecoveryFileIdentity> {
  if (path.resolve(filePath) !== filePath) {
    throw repairError(code, "恢复点文件路径必须是规范绝对路径。");
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    throw repairError(code, "恢复点文件不可访问。");
  }
  try {
    const [descriptorBefore, pathBefore, realBefore] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
      fs.realpath(filePath)
    ]);
    assertBoundRecoveryFile(
      filePath,
      descriptorBefore,
      pathBefore,
      realBefore,
      code
    );
    const digest = await hashOpenFile(handle, descriptorBefore.size, code);
    const [descriptorAfter, pathAfter, realAfter] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
      fs.realpath(filePath)
    ]);
    assertBoundRecoveryFile(
      filePath,
      descriptorAfter,
      pathAfter,
      realAfter,
      code
    );
    const identity = `${descriptorBefore.dev}:${descriptorBefore.ino}`;
    if (identity !== `${descriptorAfter.dev}:${descriptorAfter.ino}`
      || descriptorBefore.nlink !== descriptorAfter.nlink
      || descriptorBefore.size !== descriptorAfter.size
      || `${pathBefore.dev}:${pathBefore.ino}` !== `${pathAfter.dev}:${pathAfter.ino}`
      || pathBefore.nlink !== pathAfter.nlink
      || pathBefore.size !== pathAfter.size
      || (expected.expectedBytes !== undefined
        && descriptorAfter.size !== expected.expectedBytes)
      || (expected.expectedSha256 !== undefined
        && digest !== expected.expectedSha256)) {
      throw repairError(code, "恢复点文件内容或身份与绑定不一致。");
    }
    return {
      path: filePath,
      identity,
      nlink: descriptorAfter.nlink,
      size: descriptorAfter.size,
      sha256: digest
    };
  } catch (error) {
    if (isRepairError(error)) throw error;
    throw repairError(code, "恢复点文件物理绑定失败。");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertBoundRecoveryFile(
  filePath: string,
  descriptor: { dev: number; ino: number; nlink: number; size: number; isFile(): boolean },
  pathStat: { dev: number; ino: number; nlink: number; size: number; isFile(): boolean; isSymbolicLink(): boolean },
  realPath: string,
  code: string
) {
  if (!descriptor.isFile()
    || !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || descriptor.nlink !== 1
    || pathStat.nlink !== 1
    || `${descriptor.dev}:${descriptor.ino}` !== `${pathStat.dev}:${pathStat.ino}`
    || descriptor.size !== pathStat.size
    || realPath !== filePath) {
    throw repairError(code, "恢复点文件必须是已绑定的独立普通文件。");
  }
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: number,
  code: string
) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position
    );
    if (bytesRead <= 0) {
      throw repairError(code, "恢复点文件在摘要期间被截断。");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function sameRecoveryFileIdentity(
  left: RecoveryFileIdentity,
  right: RecoveryFileIdentity
) {
  return sameFullFileIdentity(left, right) && left.sha256 === right.sha256;
}

async function verifyExplicitRecoveryPoint(input: {
  workspace: string;
  agentId: string;
  recoveryPoint: string;
  recoveryPointId: string;
  identityChangeCode?: string;
  initialDatabaseClosedObserver?: (event: {
    databasePath: string;
    id: string;
  }) => void | Promise<void>;
  afterVerify?: () => void | Promise<void>;
}): Promise<VerifiedRecovery> {
  if (!path.isAbsolute(input.recoveryPoint)) {
    throw repairError("RECOVERY_POINT_INVALID", "recovery-point 必须是绝对路径。");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.recoveryPointId)) {
    throw repairError("RECOVERY_POINT_ID_INVALID", "recovery-point-id 格式无效。");
  }
  const recovery = await fs.realpath(input.recoveryPoint);
  const backupsRoot = await fs.realpath(path.join(input.workspace, "backups", "sqlite-recovery"));
  assertDescendant(backupsRoot, recovery, "RECOVERY_POINT_OUTSIDE_WORKSPACE");
  const identityChangeCode = input.identityChangeCode ?? "RECOVERY_POINT_CHANGED";
  const verificationSnapshot = await captureRecoveryVerificationSnapshot(
    recovery,
    identityChangeCode
  );
  const verifiedDatabaseSidecars: VerifiedRecoveryDatabaseSidecars[] = [];
  const verified = await runRecoveryPointVerification({
    recovery,
    failureCode: "RECOVERY_POINT_VERIFY_FAILED",
    failureMessage: "恢复点未通过完整校验。",
    async databaseClosedObserver(event) {
      if (verifiedDatabaseSidecars.some(
        (binding) => binding.databasePath === event.databasePath
      )) {
        throw repairError(identityChangeCode, "恢复点数据库被重复验证。");
      }
      verifiedDatabaseSidecars.push(await captureVerifiedDatabaseSidecars(
        event.databasePath,
        identityChangeCode
      ));
      await input.initialDatabaseClosedObserver?.(event);
    }
  });
  const postVerifyIdentity = await captureRecoveryPointIdentity(
    recovery,
    undefined,
    identityChangeCode
  );
  assertRecoveryVerificationIdentityUnchanged(
    verificationSnapshot.identity,
    postVerifyIdentity
  );
  assertVerifiedDatabaseSidecarsUnchanged(
    verifiedDatabaseSidecars,
    postVerifyIdentity
  );
  const manifest = verified.manifest;
  if (manifest.recoveryPointId !== input.recoveryPointId) {
    throw repairError("RECOVERY_POINT_ID_MISMATCH", "恢复点 ID 与 manifest 不一致。");
  }
  if (manifest.consistency?.mode !== "offline-quiesced"
    || manifest.consistency.checkpoint !== "wal_checkpoint(TRUNCATE)"
    || manifest.consistency.lock !== "BEGIN EXCLUSIVE") {
    throw repairError("RECOVERY_POINT_NOT_QUIESCED", "恢复点不是完整 offline-quiesced 恢复点。");
  }
  const createdAt = requiredText(manifest.createdAt, "RECOVERY_POINT_INVALID");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw repairError("RECOVERY_POINT_INVALID", "恢复点 createdAt 无效。");
  }
  const databases = (manifest.databases ?? []).map((entry): RecoveryDatabase => {
    if (typeof entry.id !== "string"
      || typeof entry.agentId !== "string"
      || (entry.kind !== "application" && entry.kind !== "session_queue")
      || typeof entry.source !== "string"
      || typeof entry.file !== "string"
      || typeof entry.bytes !== "number"
      || !Number.isInteger(entry.bytes)
      || entry.bytes <= 0
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw repairError("RECOVERY_POINT_INVALID", "恢复点数据库清单不完整。");
    }
    const databasePath = path.join(recovery, entry.file);
    const relative = path.relative(recovery, databasePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw repairError("RECOVERY_POINT_INVALID", "恢复点数据库文件路径越界。");
    }
    return {
      id: entry.id,
      agentId: entry.agentId,
      kind: entry.kind,
      source: entry.source,
      databasePath,
      expectedBytes: Number(entry.bytes),
      expectedSha256: entry.sha256
    };
  });
  const application = databases.find(
    (entry) => entry.agentId === input.agentId && entry.kind === "application"
  );
  if (!application) {
    throw repairError("RECOVERY_DATABASE_MISSING", "恢复点缺少目标 Agent application DB。");
  }
  const applicationDatabasePath = application.databasePath;
  await assertRegularFile(applicationDatabasePath);
  assertVerifiedRecoverySnapshot({
    snapshot: verificationSnapshot,
    manifest: manifest as JsonObject,
    recoveryPointId: input.recoveryPointId,
    databases,
    code: identityChangeCode
  });
  await input.afterVerify?.();
  const identityBinding = await captureRecoveryPointIdentity(
    recovery,
    databases,
    identityChangeCode
  );
  assertRecoveryPointIdentityBindingUnchanged(
    postVerifyIdentity,
    identityBinding
  );
  const finalVerified = await runRecoveryPointVerification({
    recovery,
    failureCode: identityChangeCode,
    failureMessage: "恢复点最终物理绑定未通过完整校验。"
  });
  const finalIdentityBinding = await captureRecoveryPointIdentity(
    recovery,
    databases,
    identityChangeCode
  );
  assertRecoveryPointIdentityBindingUnchanged(
    identityBinding,
    finalIdentityBinding
  );
  assertVerifiedRecoverySnapshot({
    snapshot: verificationSnapshot,
    manifest: finalVerified.manifest as JsonObject,
    recoveryPointId: input.recoveryPointId,
    databases,
    code: identityChangeCode
  });
  return {
    directory: recovery,
    recoveryPointId: input.recoveryPointId,
    createdAt,
    applicationDatabasePath,
    databases,
    identityBinding: finalIdentityBinding
  };
}

async function runRecoveryPointVerification(input: {
  recovery: string;
  failureCode: string;
  failureMessage: string;
  databaseClosedObserver?: (event: {
    databasePath: string;
    id: string;
  }) => void | Promise<void>;
}): Promise<RecoveryVerifierResult> {
  try {
    return await verifyRecoveryPoint(input.recovery, {
      databaseClosedObserver: input.databaseClosedObserver
    }) as RecoveryVerifierResult;
  } catch {
    throw repairError(input.failureCode, input.failureMessage);
  }
}

async function resolveWorkspace(workspaceInput: string) {
  if (!path.isAbsolute(workspaceInput)) {
    throw repairError("WORKSPACE_INVALID", "workspace 必须是绝对路径。");
  }
  const workspace = await fs.realpath(workspaceInput);
  const stat = await fs.lstat(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw repairError("WORKSPACE_INVALID", "workspace 必须是普通目录。");
  }
  return workspace;
}

async function resolveAgentPaths(workspace: string, agentId: string) {
  const agentRoot = path.join(workspace, "business", "agents", agentId);
  const databasePath = path.join(agentRoot, "data", "sunabot.sqlite");
  const queuePath = path.join(agentRoot, "data", "session-queue.sqlite");
  const workingMemoryPath = path.join(agentRoot, "WORKING_MEMORY.md");
  for (const filePath of [databasePath, queuePath, workingMemoryPath]) {
    await assertRegularFile(filePath);
    const resolved = await fs.realpath(filePath);
    if (resolved !== filePath) throw repairError("TARGET_PATH_UNSAFE", "目标 Agent 文件路径包含链接。");
  }
  return { databasePath, queuePath, workingMemoryPath };
}

async function assertRegularFile(filePath: string) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw repairError("FILE_UNSAFE", "迁移输入必须是独立普通文件。");
  }
}

async function snapshotExternalFiles(
  workingMemoryPath: string,
  queuePath: string
): Promise<FileSnapshot> {
  await assertRegularFile(workingMemoryPath);
  await assertRegularFile(queuePath);
  return {
    workingMemorySha256: sha256(await fs.readFile(workingMemoryPath)),
    queueFileSetSha256: await sqliteFileSetDigest(queuePath)
  };
}

async function sqliteFileSetDigest(databasePath: string) {
  const entries: Array<{ suffix: string; bytes: number; sha256: string } | { suffix: string; missing: true }> = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${databasePath}${suffix}`;
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw repairError("QUEUE_FILE_UNSAFE", "queue DB 或 sidecar 不是独立普通文件。");
      }
      const bytes = await fs.readFile(filePath);
      entries.push({ suffix, bytes: bytes.length, sha256: sha256(bytes) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push({ suffix, missing: true });
    }
  }
  return sha256(JSON.stringify(entries));
}

async function assertFileSnapshot(prepared: PreparedRepair) {
  const current = await snapshotExternalFiles(prepared.workingMemoryPath, prepared.queuePath);
  if (!sameRecord(current, prepared.fileSnapshot)) {
    throw repairError("EXTERNAL_STATE_CHANGED", "WORKING_MEMORY 或 queue DB 在修复期间发生变化。");
  }
}

async function assertServicesStopped(
  workspace: string,
  quiesced: boolean,
  probe: DreamIdentityAliasRepairServiceProbe
) {
  if (!quiesced) {
    throw repairError("QUIESCED_REQUIRED", "apply 必须在服务停止后显式提供 --quiesced。");
  }
  for (const port of [8787, 8788]) {
    if (await probe.isPortOpen(port)) {
      throw repairError("SERVICE_RUNNING", "Sunabot 运行端口仍在监听。");
    }
  }
  const hostProcesses = await probe.runningHostProcesses(workspace);
  if (hostProcesses.length) {
    throw repairError("SERVICE_RUNNING", "当前 workspace 仍有运行中的宿主进程。");
  }
  const containers = await probe.runningContainers(workspace);
  if (containers.length) {
    throw repairError("SERVICE_RUNNING", "当前 workspace 仍有运行容器。");
  }
}

const defaultServiceProbe: DreamIdentityAliasRepairServiceProbe = {
  isPortOpen: portOpen,
  async runningHostProcesses(workspace) {
    try {
      const [coreGroups, accountProcesses] = await Promise.all([
        listNativeCoreProcessGroups({ root: PROJECT_ROOT, workspace }),
        listAccountRuntimeProcesses({
          workspace,
          workspaceId: workspaceIdentity(workspace),
          entry: ACCOUNT_RUNTIME_ENTRY
        })
      ]);
      return [
        ...coreGroups.map((group: { processGroup: number }) => `native-core:${group.processGroup}`),
        ...accountProcesses.map((item: { pid: number }) => `account-runtime:${item.pid}`)
      ];
    } catch {
      throw repairError("RUNTIME_INSPECTION_FAILED", "无法核对当前 workspace 的宿主进程。");
    }
  },
  async runningContainers(workspace) {
    const result = await capture("docker", [
      "ps",
      "--filter",
      `label=io.sunabot.workspace-id=${workspaceIdentity(workspace)}`,
      "--format",
      "{{.ID}}"
    ]).catch(() => {
      throw repairError("RUNTIME_INSPECTION_FAILED", "无法核对当前 workspace 的 Docker 容器。");
    });
    if (result.code !== 0) {
      throw repairError("RUNTIME_INSPECTION_FAILED", "无法核对当前 workspace 的 Docker 容器。");
    }
    return result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }
};

function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

function capture(command: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout }));
  });
}

function replaceJsonValue(value: unknown, mapping: PrivateMapping): unknown {
  if (typeof value === "string") return replaceText(value, mapping);
  if (Array.isArray(value)) return value.map((item) => replaceJsonValue(item, mapping));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, replaceJsonValue(item, mapping)]
    ));
  }
  return value;
}

function replaceText(value: string, mapping: PrivateMapping) {
  let repaired = value;
  for (const [token, original] of mapping.replacements) {
    repaired = repaired.replaceAll(token, original);
  }
  return repaired;
}

function identityAliasToken(seed: string, value: string) {
  return `人物-${crypto.createHash("sha256")
    .update(seed)
    .update("\0alias\0")
    .update(value.normalize("NFC"))
    .digest("hex")
    .slice(0, 24)}`;
}

function canonicalJsonDigest(value: unknown) {
  return sha256(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as JsonObject;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw repairError("JSON_INVALID", "Dream JSON 包含无效值。");
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw repairError(code, "Dream 修复输入不是有效 JSON。");
  }
}

function parseJsonObject(value: string, code: string): JsonObject {
  const parsed = parseJson(value, code);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw repairError(code, "Dream 修复输入必须是 JSON object。");
  }
  return parsed as JsonObject;
}

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function arrayObjects(value: unknown) {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function requiredText(value: unknown, code: string) {
  if (typeof value !== "string" || !value) throw repairError(code, "必需文本字段缺失。");
  return value;
}

function countMatches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}

function uniqueMatches(value: string, pattern: RegExp) {
  return [...new Set([...value.matchAll(pattern)].map((match) => match[0]))].sort();
}

function hashChange(before: string | null, after: string | null): HashChange {
  return {
    beforeSha256: before == null ? null : sha256(before),
    afterSha256: after == null ? null : sha256(after)
  };
}

function sha256(value: string | Uint8Array) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertDescendant(root: string, target: string, code: string) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw repairError(code, "恢复点必须位于当前 workspace 的备份目录。");
  }
}

function assertTargetInput(input: DreamIdentityAliasRepairInput) {
  if (input.agentId !== TARGET_AGENT_ID || input.runId !== TARGET_RUN_ID) {
    throw repairError("TARGET_NOT_SUPPORTED", "该工具只允许修复已审计的 Arona Dream run。");
  }
  for (const value of Object.values({
    workspace: input.workspace,
    recoveryPoint: input.recoveryPoint,
    recoveryPointId: input.recoveryPointId
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw repairError("ARGUMENT_INVALID", "必需参数必须显式提供。");
    }
  }
}

function assertApplyInput(input: DreamIdentityAliasRepairApplyInput) {
  assertTargetInput(input);
  for (const value of Object.values({
    rollbackRecoveryPoint: input.rollbackRecoveryPoint,
    rollbackRecoveryPointId: input.rollbackRecoveryPointId,
    expectedMappingDigest: input.expectedMappingDigest
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw repairError("ARGUMENT_INVALID", "必需参数必须显式提供。");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(input.expectedMappingDigest)) {
    throw repairError("ARGUMENT_INVALID", "expected-mapping-digest 格式无效。");
  }
}

function repairError(code: string, message: string) {
  return Object.assign(new Error(message), {
    code,
    [REPAIR_ERROR_MARKER]: true as const
  });
}

function committedRepairError(rollbackRecoveryPointId: string) {
  return Object.assign(new Error(COMMITTED_REPAIR_GUIDANCE), {
    name: "DreamIdentityAliasRepairCommittedError",
    code: COMMITTED_REPAIR_ERROR_CODE,
    rollbackRecoveryPointId,
    guidance: COMMITTED_REPAIR_GUIDANCE
  });
}

function isRepairError(error: unknown): error is Error & {
  code: string;
  [REPAIR_ERROR_MARKER]: true;
} {
  return error instanceof Error
    && (error as { [REPAIR_ERROR_MARKER]?: unknown })[REPAIR_ERROR_MARKER] === true
    && typeof (error as { code?: unknown }).code === "string";
}

function isCommittedRepairError(error: unknown): error is Error & {
  code: typeof COMMITTED_REPAIR_ERROR_CODE;
  rollbackRecoveryPointId: string;
} {
  return error instanceof Error
    && (error as { code?: unknown }).code === COMMITTED_REPAIR_ERROR_CODE
    && typeof (error as { rollbackRecoveryPointId?: unknown }).rollbackRecoveryPointId === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(
      (error as { rollbackRecoveryPointId: string }).rollbackRecoveryPointId
    );
}

function sanitizeRepairFailure(error: unknown) {
  if (isCommittedRepairError(error) || isRepairError(error)) return error;
  return repairError(GENERIC_REPAIR_ERROR_CODE, GENERIC_REPAIR_ERROR_MESSAGE);
}

export function formatDreamIdentityAliasRepairError(error: unknown) {
  const sanitized = sanitizeRepairFailure(error);
  if (isCommittedRepairError(sanitized)) {
    return {
      code: COMMITTED_REPAIR_ERROR_CODE,
      rollbackRecoveryPointId: sanitized.rollbackRecoveryPointId,
      guidance: COMMITTED_REPAIR_GUIDANCE
    };
  }
  return {
    ok: false,
    code: sanitized.code,
    error: sanitized.message
  };
}

function parseArgs(argv: readonly string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowedValues = new Set([
    "workspace",
    "agent",
    "run",
    "recovery-point",
    "recovery-point-id",
    "rollback-recovery-point",
    "rollback-recovery-point-id",
    "expected-mapping-digest"
  ]);
  const allowedFlags = new Set(["apply", "quiesced"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      throw repairError("ARGUMENT_INVALID", "只接受显式命名参数。");
    }
    const key = argument.slice(2);
    if (allowedFlags.has(key)) {
      if (flags.has(key)) throw repairError("ARGUMENT_INVALID", "命令参数不能重复。");
      flags.add(key);
      continue;
    }
    if (!allowedValues.has(key) || values.has(key)) {
      throw repairError("ARGUMENT_INVALID", "命令包含未知或重复参数。");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw repairError("ARGUMENT_INVALID", "命令参数缺少值。");
    }
    values.set(key, value);
    index += 1;
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw repairError("ARGUMENT_INVALID", "必需命令参数必须显式提供。");
    return value;
  };
  const common = {
    workspace: required("workspace"),
    agentId: required("agent"),
    runId: required("run"),
    recoveryPoint: required("recovery-point"),
    recoveryPointId: required("recovery-point-id")
  };
  if (!flags.has("apply")) return { apply: false as const, common };
  return {
    apply: true as const,
    input: {
      ...common,
      rollbackRecoveryPoint: required("rollback-recovery-point"),
      rollbackRecoveryPointId: required("rollback-recovery-point-id"),
      expectedMappingDigest: required("expected-mapping-digest"),
      quiesced: flags.has("quiesced")
    }
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const result = parsed.apply
    ? await applyDreamIdentityAliasRepair(parsed.input)
    : await inspectDreamIdentityAliasRepair(parsed.common);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify(formatDreamIdentityAliasRepairError(error)));
    process.exitCode = 1;
  });
}
