import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 3;
export const RELEASE_PLATFORM_ID = "linux/amd64";

export const RELEASE_PROTECTED_FILES = Object.freeze([
  ".node-version",
  "AGENTS.md",
  "install.sh",
  "sunabot.sh",
  "deploy/runtime-contract.json",
  "components/component.lock.json",
  "package.json",
  "package-lock.json",
  "node_modules/.package-lock.json",
  "runtime/node/bin/node",
  "runtime/node/LICENSE",
  "runtime/bubblewrap/bwrap",
  "runtime/bubblewrap/LICENSE",
  "runtime/bubblewrap/SOURCE.txt",
  "sources/bubblewrap/bubblewrap_0.8.0-2+deb12u1.dsc",
  "sources/bubblewrap/bubblewrap_0.8.0.orig.tar.xz",
  "sources/bubblewrap/bubblewrap_0.8.0-2+deb12u1.debian.tar.xz",
  "runtime/lightpanda/lightpanda",
  "licenses/lightpanda/LICENSE",
  "licenses/lightpanda/SOURCE.txt",
  "packages/platform/multiAgentMigrationGate.mjs",
  "packages/platform/proxy.mjs",
  "tooling/shared/paths.mjs",
  "tooling/migrations/migrate-single-agent-to-multi-agent.mjs",
  "tooling/migrations/migrate-to-sqlite.mjs",
  "tooling/migrations/run-built-migration.mjs",
  "tooling/runtime/launcher-core.mjs",
  "tooling/runtime/release-integrity.mjs",
  "tooling/workspace/sqlite-recovery.mjs"
]);

export const RELEASE_PROTECTED_TREES = Object.freeze([
  "apps/admin-web/dist",
  "codex-skills/workbench-config",
  "config",
  "deploy",
  "dist",
  "node_modules",
  "packages/platform",
  "runtime",
  "sources",
  "tooling"
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SEALED_EVIDENCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sealed\.json$/u;
const HASH_CONCURRENCY = 32;
const EVIDENCE_GIT_BUFFER_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export function assertReleaseBuildPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== "linux" || !new Set(["x64", "arm64"]).has(arch)) {
    throw new Error(`Native release artifact 只支持 linux/x64 与 linux/arm64；当前为 ${platform}/${arch}。`);
  }
}

export function releasePlatformId(platform = process.platform, arch = process.arch) {
  assertReleaseBuildPlatform(platform, arch);
  return `linux/${arch === "x64" ? "amd64" : "arm64"}`;
}

export async function materializeReleaseEvidenceFromGit({
  root,
  evidenceCommit,
  sourceCommit,
  destination = ".user-test-runs"
}) {
  assertSourceCommit(evidenceCommit);
  assertSourceCommit(sourceCommit);
  const rootPath = path.resolve(root);
  const destinationPath = path.resolve(rootPath, destination);
  if (destinationPath !== path.join(rootPath, ".user-test-runs")) {
    throw new Error("RELEASE_EVIDENCE_DESTINATION_INVALID");
  }
  if (await exists(destinationPath)) {
    throw new Error("RELEASE_EVIDENCE_DESTINATION_EXISTS");
  }

  const ancestry = await execFileAsync("git", ["rev-list", "--parents", "-n", "1", evidenceCommit], {
    cwd: rootPath,
    encoding: "utf8"
  });
  if (ancestry.stdout.trim().split(/\s+/u).length !== 1) {
    throw new Error("RELEASE_EVIDENCE_COMMIT_NOT_ROOT");
  }

  const { stdout } = await execFileAsync("git", ["ls-tree", "-z", evidenceCommit], {
    cwd: rootPath,
    encoding: "buffer",
    maxBuffer: EVIDENCE_GIT_BUFFER_BYTES
  });
  const entries = parseEvidenceTree(stdout);
  const manifestEntry = entries.find((entry) => entry.name === "release-manifest.json");
  const sealedEntries = entries.filter((entry) => SEALED_EVIDENCE_NAME_PATTERN.test(entry.name));
  if (!manifestEntry || sealedEntries.length < 1 || sealedEntries.length + 1 !== entries.length) {
    throw new Error("RELEASE_EVIDENCE_TREE_INVALID");
  }

  const contents = new Map();
  for (const entry of entries) {
    const result = await execFileAsync("git", ["cat-file", "blob", entry.objectId], {
      cwd: rootPath,
      encoding: "buffer",
      maxBuffer: EVIDENCE_GIT_BUFFER_BYTES
    });
    contents.set(entry.name, result.stdout);
  }
  const manifest = parseEvidenceJson(contents.get("release-manifest.json"), "RELEASE_EVIDENCE_MANIFEST_INVALID");
  if (manifest.sourceRevision !== sourceCommit || !Array.isArray(manifest.cases)) {
    throw new Error("RELEASE_EVIDENCE_REVISION_MISMATCH");
  }
  const referencedReports = new Set();
  for (const item of manifest.cases) {
    if (!isRecord(item) || !Array.isArray(item.reports) || item.reports.length < 1) {
      throw new Error("RELEASE_EVIDENCE_MANIFEST_INVALID");
    }
    for (const reportName of item.reports) {
      if (typeof reportName !== "string" || !SEALED_EVIDENCE_NAME_PATTERN.test(reportName)) {
        throw new Error("RELEASE_EVIDENCE_REPORT_PATH_INVALID");
      }
      referencedReports.add(reportName);
    }
  }
  const sealedNames = sealedEntries.map((entry) => entry.name).sort(compareText);
  if (!arraysEqual([...referencedReports].sort(compareText), sealedNames)) {
    throw new Error("RELEASE_EVIDENCE_REPORT_SET_MISMATCH");
  }
  for (const reportName of sealedNames) {
    const report = parseEvidenceJson(contents.get(reportName), "RELEASE_EVIDENCE_REPORT_INVALID");
    if (report.sourceRevision !== sourceCommit) {
      throw new Error(`RELEASE_EVIDENCE_REPORT_REVISION_MISMATCH:${reportName}`);
    }
  }

  await fsPromises.mkdir(destinationPath, { mode: 0o700 });
  try {
    for (const entry of entries) {
      await fsPromises.writeFile(path.join(destinationPath, entry.name), contents.get(entry.name), {
        mode: 0o600,
        flag: "wx"
      });
    }
  } catch (error) {
    await fsPromises.rm(destinationPath, { recursive: true, force: true });
    throw error;
  }
  return { evidenceCommit, sourceCommit, files: entries.map((entry) => entry.name) };
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
  createdAt = new Date().toISOString(),
  components = {}
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
    components,
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
  const expectedPlatform = releasePlatformId(platform, arch);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("发行清单格式无效。");
  }

  const [contract, packageManifest, componentLock] = await Promise.all([
    readJson(path.join(root, "deploy/runtime-contract.json"), "runtime contract"),
    readJson(path.join(root, "package.json"), "package manifest"),
    readJson(path.join(root, "components/component.lock.json"), "component lock")
  ]);
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
    || manifest.runtimeId !== contract.runtimeId
    || manifest.releaseVersion !== contract.releaseVersion
    || manifest.releaseVersion !== packageManifest.version
    || manifest.nodeVersion !== contract.nodeVersion
    || manifest.nodeVersion !== nodeVersion
    || manifest.platform !== expectedPlatform
    || !Array.isArray(contract.supportedPlatforms)
    || !contract.supportedPlatforms.includes(expectedPlatform)
  ) {
    throw new Error("发行清单与当前迁移运行时不一致。");
  }
  const expectedComponents = {
    node: componentLock.components?.node?.version,
    lightpanda: componentLock.components?.lightpanda?.version,
    bubblewrap: componentLock.components?.bubblewrap?.version,
    napcat: componentLock.components?.napcat?.version,
    codexCli: componentLock.components?.["codex-cli"]?.version
  };
  if (!isRecord(manifest.components)
    || Object.keys(expectedComponents).some((key) => manifest.components[key] !== expectedComponents[key])) {
    throw new Error("发行清单与锁定组件版本不一致。");
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
  return { contract, packageManifest, componentLock };
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

function parseEvidenceTree(output) {
  const records = Buffer.from(output).toString("utf8").split("\0").filter(Boolean);
  return records.map((record) => {
    const separator = record.indexOf("\t");
    const metadata = record.slice(0, separator).split(" ");
    const name = record.slice(separator + 1);
    if (
      separator < 1
      || metadata.length !== 3
      || metadata[0] !== "100644"
      || metadata[1] !== "blob"
      || !SOURCE_COMMIT_PATTERN.test(metadata[2])
      || (name !== "release-manifest.json" && !SEALED_EVIDENCE_NAME_PATTERN.test(name))
    ) {
      throw new Error("RELEASE_EVIDENCE_TREE_INVALID");
    }
    return { name, objectId: metadata[2] };
  });
}

function parseEvidenceJson(bytes, code) {
  if (!Buffer.isBuffer(bytes)) throw new Error(code);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) throw new Error(code);
    return value;
  } catch {
    throw new Error(code);
  }
}

async function exists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
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
