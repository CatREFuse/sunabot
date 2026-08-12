import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PromptWorkspaceScope } from "../../services/agent/promptWorkspace.js";

const TRANSACTION_SCHEMA = "sunabot.agent-files-transaction";
const TRANSACTION_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;

export const AGENT_FILE_BATCH_TRANSACTION_FILE = ".sunabot-agent-files-transaction.json";

export interface AgentFileBatchTransactionTarget {
  id: string;
  fileName: string;
  existed: boolean;
  originalSha256?: string;
  nextSha256: string;
}

export interface AgentFileBatchTransactionJournal {
  schema: typeof TRANSACTION_SCHEMA;
  version: typeof TRANSACTION_VERSION;
  transactionId: string;
  phase: "prepared" | "committed";
  scope: PromptWorkspaceScope;
  targets: AgentFileBatchTransactionTarget[];
}

export function createBatchTransactionJournal(input: Omit<AgentFileBatchTransactionJournal, "schema" | "version">) {
  return {
    schema: TRANSACTION_SCHEMA,
    version: TRANSACTION_VERSION,
    ...input
  } satisfies AgentFileBatchTransactionJournal;
}

export async function readBatchTransactionJournal(
  filePath: string
): Promise<AgentFileBatchTransactionJournal | undefined> {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JOURNAL_BYTES) {
    throw new Error("人格文件事务 journal 无效。");
  }
  const bytes = await fs.readFile(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("人格文件事务 journal 不是有效 UTF-8。");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("人格文件事务 journal 不是有效 JSON。");
  }
  return parseBatchTransactionJournal(value);
}

export async function writeBatchTransactionJournal(
  journalPath: string,
  journal: AgentFileBatchTransactionJournal
) {
  const temporaryPath = `${journalPath}.${journal.transactionId}.tmp`;
  try {
    await durableWriteFile(temporaryPath, `${JSON.stringify(journal)}\n`, false);
    await fs.rename(temporaryPath, journalPath);
    await syncDirectory(path.dirname(journalPath));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeBatchTransactionJournal(journalPath: string) {
  await fs.rm(journalPath, { force: true });
  await syncDirectory(path.dirname(journalPath));
}

export async function finishCommittedBatchTransaction(
  journalPath: string,
  targets: readonly { temporaryPath: string; backupPath: string }[]
) {
  await cleanupBatchArtifacts(targets);
  await removeBatchTransactionJournal(journalPath);
}

export async function readTransactionArtifact(
  filePath: string,
  expectedSha256: string,
  maximumBytes: number
) {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) {
    throw new Error(`人格文件事务备份无效：${path.basename(filePath)}。`);
  }
  const bytes = await fs.readFile(filePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`人格文件事务备份不是有效 UTF-8：${path.basename(filePath)}。`);
  }
  if (sha256Content(content) !== expectedSha256) {
    throw new Error(`人格文件事务备份校验失败：${path.basename(filePath)}。`);
  }
  return content;
}

export async function durableWriteFile(filePath: string, content: string, exclusive: boolean) {
  const handle = await fs.open(filePath, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableAtomicWrite(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.recovery.tmp`;
  try {
    await durableWriteFile(temporaryPath, content, true);
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncDirectories(directories: readonly string[]) {
  for (const directory of new Set(directories)) await syncDirectory(directory);
}

export async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function sha256Content(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export async function cleanupBatchArtifacts(
  targets: readonly { temporaryPath: string; backupPath: string }[]
) {
  await Promise.all(targets.flatMap((target) => [
    fs.rm(target.temporaryPath, { force: true }),
    fs.rm(target.backupPath, { force: true })
  ]));
}

function parseBatchTransactionJournal(value: unknown): AgentFileBatchTransactionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("人格文件事务 journal 结构无效。");
  }
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => !["schema", "version", "transactionId", "phase", "scope", "targets"].includes(key))
    || root.schema !== TRANSACTION_SCHEMA
    || root.version !== TRANSACTION_VERSION
    || typeof root.transactionId !== "string"
    || !/^[a-f0-9]{24}$/.test(root.transactionId)
    || (root.phase !== "prepared" && root.phase !== "committed")
    || (root.scope !== "persona" && root.scope !== "system")
    || !Array.isArray(root.targets)
  ) {
    throw new Error("人格文件事务 journal 结构无效。");
  }
  const ids = new Set<string>();
  const targets = root.targets.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("人格文件事务目标无效。");
    }
    const target = value as Record<string, unknown>;
    const allowed = ["id", "fileName", "existed", "originalSha256", "nextSha256"];
    if (
      Object.keys(target).some((key) => !allowed.includes(key))
      || typeof target.id !== "string"
      || ids.has(target.id)
      || typeof target.fileName !== "string"
      || typeof target.existed !== "boolean"
      || typeof target.nextSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(target.nextSha256)
      || (target.existed
        ? typeof target.originalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.originalSha256)
        : target.originalSha256 !== undefined)
    ) {
      throw new Error("人格文件事务目标无效。");
    }
    ids.add(target.id);
    return {
      id: target.id,
      fileName: target.fileName,
      existed: target.existed,
      ...(target.existed ? { originalSha256: target.originalSha256 as string } : {}),
      nextSha256: target.nextSha256
    };
  });
  return {
    schema: TRANSACTION_SCHEMA,
    version: TRANSACTION_VERSION,
    transactionId: root.transactionId,
    phase: root.phase,
    scope: root.scope,
    targets
  };
}
