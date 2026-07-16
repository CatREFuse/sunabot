import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getConfigPath,
  getWorkspaceDir,
  getWorkspacePath,
  loadConfig,
  normalizeConfigDocument,
  saveConfig
} from "../config.js";
import type { AppConfig } from "../types.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { AdminApiError, conflict } from "./errors.js";
import type { AdminMutationMutex, AdminRecoveryState } from "./mutation.js";
import { diffConfigDocuments } from "./configDoctorPatch.js";
import { ConfigDoctorFileError, readConfigFileNoFollow } from "./configDoctorFile.js";

export interface DoctorCandidateInput {
  expectedFileRevision: string;
  candidate: AppConfig;
  runtimeCandidate: AppConfig;
  source: "rules" | "ai";
  provider?: { label: string; model: string; destination: string };
  changes: Array<{ path: string; action: "add" | "replace" | "remove"; risk: "low" | "medium" }>;
}

interface PreparedConfigApply {
  verify?(): Promise<void>;
  commit(): void | Promise<void>;
}

interface ConfigDoctorApplyOptions {
  prepareApply: (candidate: AppConfig) => Promise<PreparedConfigApply>;
  validate: (candidate: AppConfig) => void;
  getActiveConfig?: () => AppConfig;
  backupRoot?: string;
  mutex: AdminMutationMutex;
  recoveryState: AdminRecoveryState;
}

export class ConfigDoctorApplyService {
  constructor(private readonly options: ConfigDoctorApplyOptions) {}

  async apply(input: DoctorCandidateInput) {
    return this.options.mutex.runExclusive(async () => {
      const recoveryError = this.options.recoveryState.get();
      if (recoveryError) throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", recoveryError);

      const configPath = getConfigPath();
      const original = await readConfigForApply(configPath);
      const currentFileRevision = fileRevision(original);
      if (currentFileRevision !== input.expectedFileRevision) {
        conflict("CONFIG_REVISION_CONFLICT", "配置已变化，请重新检查。", currentFileRevision);
      }

      this.options.validate(input.candidate);
      const persistedRuntimeConfig = normalizeConfigDocument(input.candidate);
      const runtimeCandidate = normalizeConfigDocument(input.runtimeCandidate);
      this.options.validate(persistedRuntimeConfig);
      this.options.validate(runtimeCandidate);
      const activeConfig = structuredClone(this.options.getActiveConfig?.() ?? await loadConfig());
      const restartRequired = diffConfigDocuments(runtimeCandidate, persistedRuntimeConfig, {
        ignoreNormalizationArtifacts: false
      }).length > 0;
      const prepared = await this.options.prepareApply(runtimeCandidate);

      const latest = await readConfigForApply(configPath);
      const latestRevision = fileRevision(latest);
      if (latestRevision !== currentFileRevision) {
        conflict("CONFIG_REVISION_CONFLICT", "配置文件已在外部修改，请重新检查。", latestRevision);
      }
      await prepared.verify?.();

      const repairId = createRepairId();
      const serializedCandidate = Buffer.from(`${JSON.stringify(input.candidate, null, 2)}\n`, "utf8");
      const candidateRevision = fileRevision(serializedCandidate);
      const backup = await createDoctorBackup({
        repairId,
        original,
        beforeRevision: currentFileRevision,
        afterRevision: candidateRevision,
        source: input.source,
        provider: input.provider,
        changes: input.changes,
        backupRoot: this.options.backupRoot
      });

      try {
        const beforePersist = await readConfigForApply(configPath);
        const beforePersistRevision = fileRevision(beforePersist);
        if (beforePersistRevision !== currentFileRevision) {
          conflict("CONFIG_REVISION_CONFLICT", "配置文件已在外部修改，请重新检查。", beforePersistRevision);
        }
      } catch (error) {
        await backup.cleanup();
        throw error;
      }

      let persisted = false;
      try {
        await saveConfig(input.candidate);
        persisted = true;
        const saved = await readConfigForApply(configPath);
        const savedRevision = fileRevision(saved);
        if (savedRevision !== candidateRevision) throw new Error("配置写入后的完整性校验失败。");
        const reloaded = await loadConfig();
        this.options.validate(reloaded);
        await prepared.commit();
        return {
          ok: true as const,
          repairId,
          repairedAt: new Date().toISOString(),
          sourceRevision: savedRevision,
          backupPath: backup.displayPath,
          restartRequired,
          appliedChanges: input.changes.length
        };
      } catch (error) {
        if (!persisted) throw error;
        try {
          const current = await readConfigForApply(configPath);
          if (fileRevision(current) !== candidateRevision) {
            throw new Error("配置在自动恢复前已被外部修改。");
          }
          const rollback = await this.options.prepareApply(activeConfig);
          await writeRawConfig(configPath, original);
          await rollback.commit();
        } catch (rollbackError) {
          const message = `配置修复失败且自动恢复失败。恢复点：${backup.displayPath}。${errorMessage(rollbackError)}`;
          this.options.recoveryState.requireRecovery(message);
          throw new AdminApiError(503, "CONFIG_RECOVERY_REQUIRED", message);
        }
        throw error;
      }
    });
  }
}

async function createDoctorBackup(input: {
  repairId: string;
  original: Buffer;
  beforeRevision: string;
  afterRevision: string;
  source: "rules" | "ai";
  provider?: { label: string; model: string; destination: string };
  changes: DoctorCandidateInput["changes"];
  backupRoot?: string;
}) {
  const backupRoot = input.backupRoot ?? getWorkspacePath(WORKSPACE_LAYOUT.backups, "config-doctor");
  const trustedRoot = input.backupRoot ? path.dirname(getConfigPath()) : getWorkspaceDir();
  await assertSafeDirectoryChain(trustedRoot, backupRoot);
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await assertSafeDirectoryChain(trustedRoot, backupRoot);
  const directory = path.join(backupRoot, input.repairId);
  await fs.mkdir(directory, { mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new AdminApiError(409, "CONFIG_DOCTOR_BACKUP_PATH_UNSAFE", "配置备份目录路径不安全。");
  }
  const beforePath = path.join(directory, "before.json");
  await writeSyncedFile(beforePath, input.original, 0o600);
  const manifest = {
    schemaVersion: 1,
    repairId: input.repairId,
    target: WORKSPACE_LAYOUT.config,
    beforeSha256: input.beforeRevision,
    afterSha256: input.afterRevision,
    source: input.source,
    ...(input.provider ? { provider: { label: input.provider.label, model: input.provider.model } } : {}),
    changes: input.changes,
    createdAt: new Date().toISOString()
  };
  await writeSyncedFile(
    path.join(directory, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    0o600
  );
  await syncDirectory(directory);
  await syncDirectory(backupRoot);
  const displayBase = input.backupRoot ? path.dirname(getConfigPath()) : getWorkspaceDir();
  return {
    displayPath: path.relative(displayBase, beforePath).replaceAll(path.sep, "/"),
    cleanup: () => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  };
}

async function assertSafeDirectoryChain(trustedRoot: string, target: string) {
  const resolvedRoot = path.resolve(trustedRoot);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AdminApiError(409, "CONFIG_DOCTOR_BACKUP_PATH_UNSAFE", "配置备份目录超出受信任范围。");
  }
  let cursor = resolvedRoot;
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of ["", ...segments]) {
    if (segment) cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AdminApiError(409, "CONFIG_DOCTOR_BACKUP_PATH_UNSAFE", "配置备份目录路径不安全。");
    }
  }
}

async function writeRawConfig(configPath: string, content: Buffer) {
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.doctor-rollback`
  );
  try {
    await writeSyncedFile(temporaryPath, content, 0o600);
    await fs.rename(temporaryPath, configPath);
    await syncDirectory(path.dirname(configPath));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeSyncedFile(filePath: string, content: Buffer, mode: number) {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, mode);
}

async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Some supported filesystems do not expose directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readConfigForApply(configPath: string) {
  try {
    return await readConfigFileNoFollow(configPath);
  } catch (error) {
    if (!(error instanceof ConfigDoctorFileError)) throw error;
    if (error.kind === "changed") {
      conflict("CONFIG_REVISION_CONFLICT", "配置检查期间发生变化，请重新检查。");
    }
    const message = error.kind === "too-large"
      ? "系统配置文件过大，未执行修复。"
      : error.kind === "missing"
        ? "系统配置文件不存在，未执行修复。"
        : "系统配置文件路径不安全，未执行修复。";
    throw new AdminApiError(409, "CONFIG_DOCTOR_PATH_UNSAFE", message);
  }
}

function createRepairId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
}

function fileRevision(content: Uint8Array) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
