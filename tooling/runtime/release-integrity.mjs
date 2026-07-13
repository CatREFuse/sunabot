import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const RELEASE_PLATFORM_ID = "linux/amd64";

export const RELEASE_PROTECTED_FILES = Object.freeze([
  "AGENTS.md",
  "deploy/runtime-contract.json",
  "package.json",
  "package-lock.json",
  "node_modules/.package-lock.json",
  "packages/platform/multiAgentMigrationGate.mjs",
  "tooling/shared/paths.mjs",
  "tooling/migrations/migrate-single-agent-to-multi-agent.mjs",
  "tooling/migrations/migrate-to-sqlite.mjs",
  "tooling/migrations/run-built-migration.mjs",
  "tooling/runtime/launcher-core.mjs",
  "tooling/runtime/release-integrity.mjs",
  "tooling/workspace/sqlite-recovery.mjs"
]);

export const RELEASE_PROTECTED_TREES = Object.freeze(["dist", "tooling", "node_modules"]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const HASH_CONCURRENCY = 32;

export function assertReleaseBuildPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(`Native release artifact 只支持 linux/x64；当前为 ${platform}/${arch}。`);
  }
}

export function assertCleanSourceStatus(status) {
  if (String(status).trim()) {
    throw new Error("发行构建要求 Git 工作树无已跟踪或未跟踪改动。");
  }
}

export function assertSourceCommit(sourceCommit) {
  if (!SOURCE_COMMIT_PATTERN.test(String(sourceCommit))) {
    throw new Error("发行清单 sourceCommit 必须是 40 位小写 Git commit。");
  }
}

export async function createReleaseManifest({
  root,
  runtimeId,
  releaseVersion,
  platform,
  nodeVersion,
  sourceCommit,
  createdAt = new Date().toISOString()
}) {
  assertSourceCommit(sourceCommit);
  const files = await hashReleaseFiles(root);
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    runtimeId,
    releaseVersion,
    platform,
    nodeVersion,
    sourceCommit,
    createdAt,
    runtimeContractSha256: files["deploy/runtime-contract.json"],
    integrity: {
      algorithm: "sha256",
      files
    }
  };
}

export async function validateReleaseManifest({
  root,
  manifest,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node
}) {
  assertReleaseBuildPlatform(platform, arch);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("发行清单格式无效。");
  }

  const [contract, packageManifest] = await Promise.all([
    readJson(path.join(root, "deploy/runtime-contract.json"), "runtime contract"),
    readJson(path.join(root, "package.json"), "package manifest")
  ]);
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
    || manifest.runtimeId !== contract.runtimeId
    || manifest.releaseVersion !== contract.releaseVersion
    || manifest.releaseVersion !== packageManifest.version
    || manifest.nodeVersion !== contract.nodeVersion
    || manifest.nodeVersion !== nodeVersion
    || manifest.platform !== RELEASE_PLATFORM_ID
    || !Array.isArray(contract.supportedPlatforms)
    || !contract.supportedPlatforms.includes(RELEASE_PLATFORM_ID)
  ) {
    throw new Error("发行清单与当前迁移运行时不一致。");
  }
  assertSourceCommit(manifest.sourceCommit);
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("发行清单 createdAt 无效。");
  }
  if (
    manifest.integrity?.algorithm !== "sha256"
    || !isRecord(manifest.integrity.files)
  ) {
    throw new Error("发行清单缺少 SHA-256 文件清单。");
  }

  const expectedPaths = await releaseIntegrityPaths(root);
  const manifestPaths = Object.keys(manifest.integrity.files).sort(compareText);
  if (!arraysEqual(manifestPaths, expectedPaths)) {
    throw new Error("发行文件清单与当前预构建产物不一致。");
  }
  const contractHash = manifest.integrity.files["deploy/runtime-contract.json"];
  if (!SHA256_PATTERN.test(String(manifest.runtimeContractSha256))
    || manifest.runtimeContractSha256 !== contractHash) {
    throw new Error("发行清单未绑定 runtime contract。");
  }

  for (const relative of expectedPaths) {
    const expected = manifest.integrity.files[relative];
    if (!SHA256_PATTERN.test(String(expected))) {
      throw new Error(`发行文件 SHA-256 无效：${relative}。`);
    }
  }
  const actualHashes = await hashListedFiles(root, expectedPaths);
  for (const relative of expectedPaths) {
    const expected = manifest.integrity.files[relative];
    const actual = actualHashes[relative];
    if (actual !== expected) {
      throw new Error(`发行文件校验失败：${relative}。`);
    }
  }
  return { contract, packageManifest };
}

export async function hashReleaseFiles(root) {
  return hashListedFiles(root, await releaseIntegrityPaths(root));
}

export async function releaseIntegrityPaths(root) {
  const protectedFiles = [];
  for (const relative of RELEASE_PROTECTED_FILES) {
    await checkedRegularFile(root, relative);
    protectedFiles.push(relative);
  }
  const protectedTreeFiles = [];
  for (const relative of RELEASE_PROTECTED_TREES) {
    const files = await listRegularFiles(root, relative);
    if (files.length === 0) throw new Error(`发行包缺少 ${relative} 文件。`);
    protectedTreeFiles.push(...files);
  }
  return [...new Set([...protectedFiles, ...protectedTreeFiles])].sort(compareText);
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashListedFiles(root, paths) {
  const pairs = await mapWithConcurrency(paths, HASH_CONCURRENCY, async (relative) => [
    relative,
    await sha256File(await checkedListedRegularFile(root, relative))
  ]);
  return Object.fromEntries(pairs);
}

async function listRegularFiles(root, relativeDirectory) {
  const absolute = checkedPath(root, relativeDirectory);
  const stat = await fsPromises.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`发行目录必须是普通目录：${relativeDirectory}。`);
  }
  const entries = (await fsPromises.readdir(absolute, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.name === ".bin" && isWithinNodeModules(relativeDirectory)) {
      if (!entry.isDirectory()) throw new Error(`发行依赖 .bin 必须是普通目录：${relative}。`);
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`发行文件不能是符号链接：${relative}。`);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`发行文件类型无效：${relative}。`);
  }
  return files;
}

async function checkedListedRegularFile(root, relative) {
  const absolute = checkedPath(root, relative);
  const stat = await fsPromises.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`发行文件必须是普通文件：${relative}。`);
  }
  return absolute;
}

async function checkedRegularFile(root, relative) {
  const absolute = checkedPath(root, relative);
  let current = path.resolve(root);
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    const stat = await fsPromises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`发行文件不能是符号链接：${relative}。`);
  }
  const stat = await fsPromises.lstat(absolute);
  if (!stat.isFile()) throw new Error(`发行文件必须是普通文件：${relative}。`);
  return absolute;
}

function checkedPath(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\")) {
    throw new Error(`发行文件路径无效：${String(relative)}。`);
  }
  const rootPath = path.resolve(root);
  const absolute = path.resolve(rootPath, relative);
  if (absolute === rootPath || !absolute.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`发行文件路径越界：${relative}。`);
  }
  return absolute;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} 无法读取：${error.message}`);
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWithinNodeModules(relative) {
  return relative === "node_modules" || relative.startsWith("node_modules/");
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
