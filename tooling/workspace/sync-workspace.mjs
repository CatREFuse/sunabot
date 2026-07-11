#!/usr/bin/env node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import { resolveProjectRoot } from "../shared/paths.mjs";

const MAGIC = Buffer.from("SUNAWS01", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const action = process.argv[2] ?? "status";
const root = resolveProjectRoot(import.meta.url);
const workspace = resolvePath(option("workspace") ?? process.env.SUNABOT_WORKSPACE ?? "workspace", root);
dotenv.config({ path: path.join(workspace, "secrets/runtime.env"), override: false });
const tier = option("tier") ?? "business";
const tierConfig = resolveTier(tier);
const syncDir = resolveOptionalPath(option("sync-dir") ?? process.env.SUNABOT_SYNC_DIR, root);
const keyPath = resolveOptionalPath(option("key-file") ?? process.env[tierConfig.keyEnvironment], root);
const archiveName = tierConfig.archiveName;

if (action === "init-key") {
  if (!keyPath) throw new Error("请通过 --key-file 或 SUNABOT_SYNC_KEY_FILE 指定独立密钥位置。");
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.writeFile(keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  console.log(`同步密钥已创建：${keyPath}`);
} else if (action === "push") {
  assertConfigured();
  await fs.mkdir(syncDir, { recursive: true });
  if (tier === "business") await checkpointSqlite(path.join(workspace, "business"));
  await assertTierPresent(workspace, tierConfig.sources);
  const temporaryTar = path.join(os.tmpdir(), `sunabot-${tier}-${process.pid}-${Date.now()}.tar`);
  const temporaryEncrypted = path.join(syncDir, `.${archiveName}.${process.pid}.${Date.now()}.tmp`);
  try {
    await run("tar", [
      "-cf", temporaryTar,
      "--exclude=*.sqlite-wal",
      "--exclude=*.sqlite-shm",
      "--exclude=*.pid",
      "--exclude=*.out",
      "-C", workspace,
      ...tierConfig.sources
    ]);
    await encryptFile(temporaryTar, temporaryEncrypted, await readKey(keyPath));
    await fs.rename(temporaryEncrypted, path.join(syncDir, archiveName));
    await fs.writeFile(path.join(syncDir, `${archiveName}.sha256`), `${await sha256File(path.join(syncDir, archiveName))}  ${archiveName}\n`, "utf8");
    console.log(`workspace 加密快照已同步：${path.join(syncDir, archiveName)}`);
  } finally {
    await fs.rm(temporaryTar, { force: true });
    await fs.rm(temporaryEncrypted, { force: true });
  }
} else if (action === "pull") {
  assertConfigured();
  await assertTierTargetsEmpty(workspace, tierConfig.sources);
  await fs.mkdir(workspace, { recursive: true });
  const encrypted = path.join(syncDir, archiveName);
  const temporaryTar = path.join(os.tmpdir(), `sunabot-workspace-restore-${process.pid}-${Date.now()}.tar`);
  try {
    await decryptFile(encrypted, temporaryTar, await readKey(keyPath));
    const listing = await run("tar", ["-tf", temporaryTar], true);
    assertSafeArchive(listing.split(/\r?\n/).filter(Boolean), tierConfig.sources);
    await run("tar", ["-xf", temporaryTar, "-C", workspace]);
    console.log(`workspace 已从加密快照恢复：${workspace}`);
  } finally {
    await fs.rm(temporaryTar, { force: true });
  }
} else if (action === "status") {
  console.log(JSON.stringify({
    workspace,
    tier,
    syncDir: syncDir ?? null,
    keyPath: keyPath ?? null,
    archivePresent: Boolean(syncDir && fsSync.existsSync(path.join(syncDir, archiveName)))
  }, null, 2));
} else {
  throw new Error("用法：sync-workspace.mjs status|init-key|push|pull [--tier business|runtime|secrets] [--sync-dir PATH] [--key-file PATH] [--workspace PATH]");
}

function assertConfigured() {
  if (!syncDir) throw new Error("请配置 SUNABOT_SYNC_DIR 或 --sync-dir。");
  if (!keyPath) throw new Error(`请配置 ${tierConfig.keyEnvironment} 或 --key-file。`);
  if (tier === "secrets") {
    const businessKey = resolveOptionalPath(process.env.SUNABOT_SYNC_KEY_FILE, root);
    if (businessKey && path.resolve(businessKey) === path.resolve(keyPath)) {
      throw new Error("secrets 快照必须使用独立于 business 快照的密钥。");
    }
  }
}

async function checkpointSqlite(directory) {
  for (const filePath of await walk(directory)) {
    if (!filePath.endsWith(".sqlite")) continue;
    const database = new DatabaseSync(filePath);
    try {
      database.exec("PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(FULL);");
    } finally {
      database.close();
    }
  }
}

async function walk(directory) {
  const result = [];
  for (const entry of await readDirectoryEntriesSafely(directory)) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

async function encryptFile(source, destination, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const output = fsSync.createWriteStream(destination, { mode: 0o600 });
  output.write(MAGIC);
  output.write(iv);
  await pipeWithoutEnding(fsSync.createReadStream(source), cipher, output);
  output.write(cipher.getAuthTag());
  await closeStream(output);
}

async function decryptFile(source, destination, key) {
  const stat = await fs.stat(source);
  if (stat.size <= MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error("同步快照格式无效。");
  const handle = await fs.open(source, "r");
  const header = Buffer.alloc(MAGIC.length + IV_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("同步快照标识无效。");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeToEnd(
    fsSync.createReadStream(source, { start: header.length, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    fsSync.createWriteStream(destination, { mode: 0o600 })
  );
}

function pipeWithoutEnding(input, transform, output) {
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    input.on("error", fail);
    transform.on("error", fail);
    output.on("error", fail);
    transform.on("end", resolve);
    input.pipe(transform).pipe(output, { end: false });
  });
}

function pipeToEnd(input, transform, output) {
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    input.on("error", fail);
    transform.on("error", fail);
    output.on("error", fail);
    output.on("finish", resolve);
    input.pipe(transform).pipe(output);
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end();
  });
}

async function readKey(filePath) {
  const value = await fs.readFile(filePath);
  if (value.length !== 32) throw new Error("同步密钥必须恰好为 32 个随机字节。");
  return value;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertSafeArchive(entries, allowedRoots) {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`同步快照包含不安全路径：${entry}`);
    }
    const allowed = allowedRoots.some((rootPath) => normalized === rootPath || normalized.startsWith(`${rootPath}/`));
    if (!allowed) throw new Error(`同步快照包含 tier 之外的路径：${entry}`);
  }
}

async function readDirectorySafely(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readDirectoryEntriesSafely(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertTierPresent(base, sources) {
  for (const source of sources) {
    if ((await readDirectorySafely(path.join(base, source))).length === 0) {
      throw new Error(`${source} 不存在或为空，不能创建 ${tier} 快照。`);
    }
  }
}

async function assertTierTargetsEmpty(base, sources) {
  for (const source of sources) {
    if ((await readDirectorySafely(path.join(base, source))).length > 0) {
      throw new Error(`目标 ${source} 非空；为避免覆盖用户数据，pull 只允许恢复到空 tier。`);
    }
  }
}

function resolveTier(value) {
  if (value === "business") {
    return { archiveName: "sunabot-business.latest.enc", keyEnvironment: "SUNABOT_SYNC_KEY_FILE", sources: ["business"] };
  }
  if (value === "runtime") {
    return { archiveName: "sunabot-runtime.latest.enc", keyEnvironment: "SUNABOT_RUNTIME_SYNC_KEY_FILE", sources: ["runtime/napcat"] };
  }
  if (value === "secrets") {
    return { archiveName: "sunabot-secrets.latest.enc", keyEnvironment: "SUNABOT_SECRETS_SYNC_KEY_FILE", sources: ["secrets"] };
  }
  throw new Error(`未知快照 tier：${value}`);
}

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} 失败（${code}）：${stderr}`)));
  });
}

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolvePath(value, base) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

function resolveOptionalPath(value, base) {
  const text = value?.trim();
  return text ? resolvePath(text, base) : undefined;
}
