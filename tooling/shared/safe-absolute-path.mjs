import fs from "node:fs/promises";
import path from "node:path";

const DARWIN_SYSTEM_ALIASES = new Map([
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"]
]);

export class AbsolutePathSafetyError extends Error {
  constructor(message, candidate) {
    super(message);
    this.name = "AbsolutePathSafetyError";
    this.code = "ABSOLUTE_PATH_UNSAFE";
    this.candidate = candidate;
  }
}

export async function ensureSafeAbsoluteDirectory(directoryInput, options = {}) {
  if (typeof directoryInput !== "string" || !path.isAbsolute(directoryInput)) {
    throw unsafe("目录必须是绝对路径", directoryInput);
  }
  const requestedDirectory = path.normalize(directoryInput);
  const directory = await canonicalizeControlledSystemAlias(requestedDirectory);
  const parsed = path.parse(directory);
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  await assertDirectory(current);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats = await lstatOrMissing(current);
    if (!stats && options.create === true) {
      try {
        await fs.mkdir(current, { mode: options.mode ?? 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stats = await lstatOrMissing(current);
    }
    if (!stats) throw unsafe(`目录链包含缺失路径：${current}`, directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafe(`目录链包含符号链接或非目录路径：${current}`, directory);
    }
  }
  return directory;
}

async function canonicalizeControlledSystemAlias(directory) {
  if (process.platform !== "darwin") return directory;
  for (const [alias, canonical] of DARWIN_SYSTEM_ALIASES) {
    if (directory !== alias && !directory.startsWith(`${alias}${path.sep}`)) continue;
    const aliasStats = await lstatOrMissing(alias);
    if (!aliasStats?.isSymbolicLink()) return directory;
    const linkTarget = await fs.readlink(alias);
    const resolvedTarget = path.resolve(path.dirname(alias), linkTarget);
    if (resolvedTarget !== canonical) {
      throw unsafe(`系统目录别名目标异常：${alias}`, directory);
    }
    const canonicalStats = await lstatOrMissing(canonical);
    if (!canonicalStats || canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) {
      throw unsafe(`系统目录别名 canonical 根无效：${canonical}`, directory);
    }
    const relative = path.relative(alias, directory);
    return relative ? path.join(canonical, relative) : canonical;
  }
  return directory;
}

export async function ensureSafeAbsoluteParent(candidateInput, options = {}) {
  if (typeof candidateInput !== "string" || !path.isAbsolute(candidateInput)) {
    throw unsafe("路径必须是绝对路径", candidateInput);
  }
  const candidate = path.normalize(candidateInput);
  await ensureSafeAbsoluteDirectory(path.dirname(candidate), {
    create: options.create === true,
    mode: options.mode
  });
  return candidate;
}

async function assertDirectory(directory) {
  const stats = await lstatOrMissing(directory);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafe(`绝对路径根目录无效：${directory}`, directory);
  }
}

async function lstatOrMissing(candidate) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function unsafe(message, candidate) {
  return new AbsolutePathSafetyError(message, candidate);
}
