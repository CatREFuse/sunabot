import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export function normalizeAdminUsername(value) {
  const username = String(value ?? "").trim().normalize("NFC");
  if (!username || username.length > 128 || !/^[\p{L}\p{N}._-]+$/u.test(username)) {
    throw new Error("管理员名称只能包含文字、数字、点、下划线和短横线，且不能超过 128 个字符。");
  }
  return username;
}

export function validateAdminPassword(value) {
  const password = String(value ?? "");
  if (password.length < 12) throw new Error("管理员密码至少需要 12 个字符。");
  if (password.length > 1024) throw new Error("管理员密码过长。");
  return password;
}

export function assertMatchingAdminPasswords(password, confirmation) {
  if (password !== confirmation) throw new Error("两次输入的管理员密码不一致。");
}

export async function createAdminCredentialRecord(options) {
  const username = normalizeAdminUsername(options.username);
  const password = validateAdminPassword(options.password);
  const now = (options.now ?? new Date()).toISOString();
  const createdAt = typeof options.previous?.createdAt === "string"
    ? options.previous.createdAt
    : now;
  const salt = (options.randomBytes ?? crypto.randomBytes)(16).toString("base64url");
  const keyLength = 64;
  const derive = options.derive ?? ((secret, value, length) => (
    scrypt(secret, value, length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  ));
  const derived = await derive(password, salt, keyLength);
  return {
    version: 1,
    username,
    password: {
      algorithm: "scrypt",
      salt,
      hash: Buffer.from(derived).toString("base64url"),
      keyLength
    },
    createdAt,
    updatedAt: now
  };
}

export function validateAdminCredentialRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("管理员凭据文件格式无效。");
  }
  const record = value;
  const username = normalizeAdminUsername(record.username);
  if (
    record.version !== 1
    || record.username !== username
    || !record.password
    || typeof record.password !== "object"
    || Array.isArray(record.password)
    || record.password.algorithm !== "scrypt"
    || record.password.keyLength !== 64
    || !validBase64Url(record.password.salt, 16)
    || !validBase64Url(record.password.hash, 64)
    || !validTimestamp(record.createdAt)
    || !validTimestamp(record.updatedAt)
  ) {
    throw new Error("管理员凭据文件格式无效。");
  }
  return record;
}

export async function readAdminCredentialRecord(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("管理员凭据文件格式无效。");
    throw error;
  }
  return validateAdminCredentialRecord(parsed);
}

export async function writeAdminCredentialRecord(filePath, record) {
  validateAdminCredentialRecord(record);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function validBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === byteLength && decoded.toString("base64url") === value;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
