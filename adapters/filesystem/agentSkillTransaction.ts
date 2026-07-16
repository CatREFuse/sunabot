import path from "node:path";
import { assertExtensionId } from "../../packages/contracts/extensions/agentExtensions.js";
import { assertWithin, storeError } from "./agentExtensionSecureFs.js";

export interface SkillTransaction {
  schemaVersion: 1;
  state: "prepared" | "committed" | "rolled_back";
  id: string;
  previousDigest: string | null;
  nextDigest: string;
  stageName: string;
  backupName: string;
}

export interface SkillRemovalTransaction {
  schemaVersion: 1;
  state: "prepared" | "committed" | "rolled_back";
  id: string;
  digest: string;
  backupName: string;
}

export function parseSkillTransaction(value: unknown): SkillTransaction {
  const record = objectRecord(value);
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "backupName,id,nextDigest,previousDigest,schemaVersion,stageName,state" || record.schemaVersion !== 1 ||
      (record.state !== "prepared" && record.state !== "committed" && record.state !== "rolled_back") ||
      typeof record.id !== "string" || !sha256(record.nextDigest) ||
      (record.previousDigest !== null && !sha256(record.previousDigest)) ||
      typeof record.stageName !== "string" || typeof record.backupName !== "string") {
    invalidTransaction("Skill 安装事务无效。");
  }
  try {
    return { ...record, id: assertExtensionId(record.id) } as unknown as SkillTransaction;
  } catch {
    invalidTransaction("Skill 安装事务无效。");
  }
}

export function parseSkillRemovalTransaction(value: unknown): SkillRemovalTransaction {
  const record = objectRecord(value);
  if (Object.keys(record).sort().join(",") !== "backupName,digest,id,schemaVersion,state" || record.schemaVersion !== 1 ||
      (record.state !== "prepared" && record.state !== "committed" && record.state !== "rolled_back") ||
      typeof record.id !== "string" || !sha256(record.digest) || typeof record.backupName !== "string") {
    invalidTransaction("Skill 卸载事务无效。");
  }
  try {
    return {
      schemaVersion: 1,
      state: record.state,
      id: assertExtensionId(record.id),
      digest: record.digest,
      backupName: record.backupName
    };
  } catch {
    invalidTransaction("Skill 卸载事务无效。");
  }
}

export function safeInternalPath(root: string, name: string, prefix: string) {
  if (path.basename(name) !== name || !name.startsWith(prefix) || name.includes("\\") || name.includes("\0")) {
    invalidTransaction("Skill 安装事务路径无效。");
  }
  const candidate = path.join(root, name);
  assertWithin(root, candidate);
  return candidate;
}

export function safeSkillTarget(root: string, id: string) {
  const candidate = path.join(root, assertExtensionId(id));
  assertWithin(root, candidate);
  return candidate;
}

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function invalidTransaction(message: string): never {
  throw storeError(409, "SKILL_TRANSACTION_INVALID", message);
}
