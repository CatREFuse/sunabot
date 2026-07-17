import os from "node:os";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { assertExtensionId } from "../../packages/contracts/extensions/agentExtensions.js";
import { safeRelativeResourcePath } from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { resolveAgentWorkbench } from "../../services/agents/public.js";
import { AgentExtensionPathGuard } from "./agentExtensionPaths.js";
import { buildSkillCopyArchive } from "./agentSkillCopyArchive.js";
import { extractSkillArchive, inspectSkillDirectory } from "./skillArchive.js";
import { safeSkillTarget } from "./agentSkillTransaction.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface AgentSkillScriptProjection {
  root: string;
  workbench: string;
  skills: string;
  manifestFile: string;
  skillDirectory: string;
  scriptFile: string;
  virtualScript: string;
  digestSha256: string;
  rootMountIdentity: FrozenSkillScriptMountIdentity;
  workbenchMountIdentity: FrozenSkillScriptMountIdentity;
  skillsMountIdentity: FrozenSkillScriptMountIdentity;
  scriptMountIdentity: FrozenSkillScriptMountIdentity;
  manifestMountIdentity: FrozenSkillScriptMountIdentity;
  dispose(): Promise<void>;
}

export interface FrozenSkillScriptMountIdentity {
  realPath: string;
  kind: "file" | "directory";
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  uid: bigint;
  mode: bigint;
  pathChain: Array<{
    path: string;
    dev: bigint;
    ino: bigint;
    ctimeNs: bigint;
    uid: bigint;
    mode: bigint;
  }>;
}

export interface AgentSkillScriptProjectionPort {
  build(input: {
    agentId: string;
    skillId: string;
    expectedDigestSha256: string;
    resourcePath: string;
    expectedResourceSha256: string;
    expectedResourceBytes: number;
  }): Promise<AgentSkillScriptProjection>;
}

interface ProjectionRootIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  parent: {
    path: string;
    dev: bigint;
    ino: bigint;
    uid: bigint;
    mode: bigint;
  };
  cleanupPath?: string;
}

export class AgentSkillScriptProjectionBuilder implements AgentSkillScriptProjectionPort {
  private readonly pathGuard: AgentExtensionPathGuard;

  constructor(private readonly options: {
    workspaceRoot: string;
    temporaryRoot?: string;
    removeProjection?: (root: string, identity: ProjectionRootIdentity) => Promise<void>;
  }) {
    this.pathGuard = new AgentExtensionPathGuard(options.workspaceRoot, {});
  }

  async build(input: {
    agentId: string;
    skillId: string;
    expectedDigestSha256: string;
    resourcePath: string;
    expectedResourceSha256: string;
    expectedResourceBytes: number;
  }): Promise<AgentSkillScriptProjection> {
    const skillId = assertExtensionId(input.skillId);
    if (!SHA256.test(input.expectedDigestSha256) || !SHA256.test(input.expectedResourceSha256) ||
        !safeRelativeResourcePath(input.resourcePath) || !input.resourcePath.startsWith("scripts/") ||
        !Number.isSafeInteger(input.expectedResourceBytes) || input.expectedResourceBytes < 1) {
      invalid();
    }
    const paths = await this.pathGuard.paths(input.agentId);
    await this.pathGuard.guard(paths, "skill-script-projection-start");
    const workbench = await resolveAgentWorkbench(path.join(
      path.resolve(this.options.workspaceRoot),
      WORKSPACE_LAYOUT.agentRoot,
      input.agentId
    ));
    const temporaryRoot = await resolvePrivateTemporaryRoot(this.options.temporaryRoot);
    const cleanup = this.options.removeProjection ?? removeProjection;
    const created = await createPrivateProjectionRoot(temporaryRoot, skillId, cleanup);
    const root = created.root;
    const skills = path.join(root, "skills");
    let archive: Buffer | undefined;
    try {
      await fs.mkdir(skills, { mode: 0o700 });
      const source = safeSkillTarget(paths.skills, skillId);
      archive = await buildSkillCopyArchive({
        directory: source,
        expectedDigestSha256: input.expectedDigestSha256
      });
      const extracted = await extractSkillArchive({ archive, stagingRoot: skills });
      if (extracted.evidence.digestSha256 !== input.expectedDigestSha256 ||
          extracted.evidence.name !== skillId) {
        invalid();
      }
      const skillDirectory = path.join(skills, skillId);
      await fs.rename(extracted.packageRoot, skillDirectory);
      const evidence = await inspectSkillDirectory(skillDirectory);
      const resource = evidence.files.find((candidate) => candidate.path === input.resourcePath);
      if (evidence.digestSha256 !== input.expectedDigestSha256 || !resource ||
          resource.bytes !== input.expectedResourceBytes || resource.sha256 !== input.expectedResourceSha256) {
        invalid();
      }
      const scriptFile = path.join(skillDirectory, ...input.resourcePath.split("/"));
      const checkedScript = await assertPinnedScript(
        scriptFile,
        input.expectedResourceBytes,
        input.expectedResourceSha256
      );
      checkedScript.fill(0);
      const manifestFile = path.join(skills, ".sunabot-skill-script-manifest.json");
      await fs.writeFile(manifestFile, `${JSON.stringify({
        schemaVersion: 1,
        skillId,
        digestSha256: input.expectedDigestSha256,
        resource: {
          path: input.resourcePath,
          bytes: input.expectedResourceBytes,
          sha256: input.expectedResourceSha256
        }
      })}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await this.pathGuard.guard(paths, "skill-script-projection-finish");
      await makeReadOnly(skills);
      await fs.chmod(root, 0o500);
      const [rootMountIdentity, workbenchMountIdentity, skillsMountIdentity, scriptMountIdentity,
        manifestMountIdentity] = await Promise.all([
        captureSkillScriptMountIdentity(root, "directory"),
        captureSkillScriptMountIdentity(workbench, "directory"),
        captureSkillScriptMountIdentity(skills, "directory"),
        captureSkillScriptMountIdentity(scriptFile, "file"),
        captureSkillScriptMountIdentity(manifestFile, "file")
      ]);
      let disposed = false;
      return {
        root,
        workbench,
        skills,
        manifestFile,
        skillDirectory,
        scriptFile,
        virtualScript: `/skills/${skillId}/${input.resourcePath}`,
        digestSha256: input.expectedDigestSha256,
        rootMountIdentity,
        workbenchMountIdentity,
        skillsMountIdentity,
        scriptMountIdentity,
        manifestMountIdentity,
        async dispose() {
          if (disposed) return;
          await cleanup(root, created.identity);
          disposed = true;
        }
      };
    } catch (error) {
      try {
        await cleanup(root, created.identity);
      } catch {
        throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
      }
      if (error instanceof Error && error.name === "SkillScriptError") throw error;
      throw scriptError("SKILL_SCRIPT_PROJECTION_INVALID");
    } finally {
      archive?.fill(0);
    }
  }
}

export async function assertPinnedProjectedSkillScript(input: {
  projection: AgentSkillScriptProjection;
  expectedDigestSha256: string;
  expectedSkillId: string;
  expectedResourcePath: string;
  expectedBytes: number;
  expectedResourceSha256: string;
}) {
  try {
    if (input.projection.digestSha256 !== input.expectedDigestSha256 ||
        !SHA256.test(input.expectedDigestSha256) || !SHA256.test(input.expectedResourceSha256) ||
        input.projection.skillDirectory !== path.join(input.projection.skills, input.expectedSkillId) ||
        input.projection.scriptFile !== path.join(
          input.projection.skillDirectory,
          ...input.expectedResourcePath.split("/")
        ) || input.projection.virtualScript !== `/skills/${input.expectedSkillId}/${input.expectedResourcePath}`) {
      invalid();
    }
    return await assertPinnedScript(input.projection.scriptFile, input.expectedBytes, input.expectedResourceSha256);
  } catch (error) {
    if (error instanceof Error && error.name === "SkillScriptError") throw error;
    invalid();
  }
}

export async function verifyAgentSkillScriptProjection(projection: AgentSkillScriptProjection) {
  try {
    await Promise.all([
      verifySkillScriptMountIdentity(projection.rootMountIdentity),
      verifySkillScriptMountIdentity(projection.workbenchMountIdentity),
      verifySkillScriptMountIdentity(projection.skillsMountIdentity),
      verifySkillScriptMountIdentity(projection.scriptMountIdentity),
      verifySkillScriptMountIdentity(projection.manifestMountIdentity)
    ]);
    if (projection.rootMountIdentity.realPath !== projection.root ||
        projection.workbenchMountIdentity.realPath !== projection.workbench ||
        projection.skillsMountIdentity.realPath !== projection.skills ||
        projection.scriptMountIdentity.realPath !== projection.scriptFile ||
        projection.manifestMountIdentity.realPath !== projection.manifestFile) {
      invalid();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "SkillScriptError") throw error;
    invalid();
  }
}

async function assertPinnedScript(file: string, expectedBytes: number, expectedSha256: string) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expectedBytes)) {
    invalid();
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let content: Buffer | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) invalid();
    content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(file, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, pathAfter) ||
        createHash("sha256").update(content).digest("hex") !== expectedSha256) {
      invalid();
    }
    return content;
  } catch (error) {
    content?.fill(0);
    throw error;
  } finally {
    try {
      await handle.close();
    } catch {
      content?.fill(0);
      throw scriptError("SKILL_SCRIPT_RESOURCE_CLOSE_FAILED");
    }
  }
}

function sameFile(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint }
) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

async function resolvePrivateTemporaryRoot(configured: string | undefined) {
  if (typeof process.getuid === "function" && process.getuid() === 0) invalid();
  const root = configured
    ? path.resolve(configured)
    : path.join(os.tmpdir(), `sunabot-skill-script-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  try {
    if (!configured) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  } catch {
    invalid();
  }
  const stat = await fs.lstat(root).catch(() => invalid());
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) ||
      (stat.mode & 0o777) !== 0o700) {
    invalid();
  }
  return fs.realpath(root).catch(() => invalid());
}

async function createPrivateProjectionRoot(
  parent: string,
  skillId: string,
  cleanup: (root: string, identity: ProjectionRootIdentity) => Promise<void>
) {
  let root: string | undefined;
  let identity: ProjectionRootIdentity | undefined;
  try {
    root = await fs.mkdtemp(path.join(parent, `sunabot-skill-script-${process.pid}-${skillId}-`));
    root = await fs.realpath(root);
    const created = await fs.lstat(root, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) invalid();
    const parentPath = path.dirname(root);
    const parentStat = await fs.lstat(parentPath, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== created.uid) invalid();
    identity = {
      dev: created.dev,
      ino: created.ino,
      uid: created.uid,
      parent: {
        path: parentPath,
        dev: parentStat.dev,
        ino: parentStat.ino,
        uid: parentStat.uid,
        mode: parentStat.mode & 0o777n
      }
    };
    await fs.chmod(root, 0o700);
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
        stat.uid !== identity.uid || Number(stat.mode & 0o777n) !== 0o700) invalid();
    return { root, identity };
  } catch {
    if (root && identity) {
      try {
        await cleanup(root, identity);
      } catch {
        throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
      }
    }
    invalid();
  }
}

async function makeReadOnly(root: string) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(target);
      await fs.chmod(target, 0o500);
    } else {
      await fs.chmod(target, 0o400);
    }
  }
  await fs.chmod(root, 0o500);
}

async function removeProjection(root: string, identity: ProjectionRootIdentity) {
  try {
    await removeProjectionInternal(root, identity);
  } catch {
    throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
  }
}

async function removeProjectionInternal(root: string, identity: ProjectionRootIdentity) {
  const parent = await fs.lstat(identity.parent.path, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== identity.parent.dev ||
      parent.ino !== identity.parent.ino || parent.uid !== identity.parent.uid ||
      (parent.mode & 0o777n) !== identity.parent.mode || path.dirname(root) !== identity.parent.path) {
    throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
  }
  const cleanupPath = identity.cleanupPath ?? path.join(
    identity.parent.path,
    `.${path.basename(root)}.cleanup-${randomBytes(16).toString("hex")}`
  );
  identity.cleanupPath = cleanupPath;
  const [source, quarantined] = await Promise.all([
    fs.lstat(root, { bigint: true }).catch((error) => missingOrThrow(error)),
    fs.lstat(cleanupPath, { bigint: true }).catch((error) => missingOrThrow(error))
  ]);
  if (source && quarantined) throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
  if (source) {
    assertProjectionRootIdentity(source, identity);
    await fs.rename(root, cleanupPath);
  } else if (!quarantined) {
    identity.cleanupPath = undefined;
    return;
  }
  const moved = await fs.lstat(cleanupPath, { bigint: true });
  try {
    assertProjectionRootIdentity(moved, identity);
  } catch (error) {
    if (!await fs.lstat(root).catch((caught) => missingOrThrow(caught))) {
      await fs.rename(cleanupPath, root).catch(() => undefined);
    }
    identity.cleanupPath = undefined;
    throw error;
  }
  await makeWritable(cleanupPath, identity.uid);
  await fs.rm(cleanupPath, { recursive: true, force: true });
  identity.cleanupPath = undefined;
}

async function makeWritable(root: string, expectedUid: bigint) {
  const stat = await fs.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid) {
    throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
  }
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    const child = await fs.lstat(target, { bigint: true });
    if (child.isSymbolicLink() || child.uid !== expectedUid) throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
    if (child.isDirectory()) await makeWritable(target, expectedUid);
    else if (child.isFile() && child.nlink === 1n) await fs.chmod(target, 0o600);
    else throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
  }
}

function invalid(): never {
  throw scriptError("SKILL_SCRIPT_PROJECTION_INVALID");
}

export async function captureSkillScriptMountIdentity(
  candidate: string,
  kind: "file" | "directory"
): Promise<FrozenSkillScriptMountIdentity> {
  if (!candidate || !path.isAbsolute(candidate) || /[\u0000\r\n]/u.test(candidate)) invalid();
  const canonical = path.resolve(candidate);
  const realPath = await fs.realpath(canonical).catch(() => invalid());
  if (canonical !== candidate || realPath !== canonical) invalid();
  const chainPaths = absolutePathChain(canonical);
  const pathChain = [];
  let leaf: BigIntStats | undefined;
  for (const chainPath of chainPaths) {
    const stat = await fs.lstat(chainPath, { bigint: true });
    if (stat.isSymbolicLink()) invalid();
    if (chainPath !== canonical && !stat.isDirectory()) invalid();
    pathChain.push({
      path: chainPath,
      dev: stat.dev,
      ino: stat.ino,
      ctimeNs: stat.ctimeNs,
      uid: stat.uid,
      mode: stat.mode & 0o777n
    });
    if (chainPath === canonical) leaf = stat;
  }
  if (!leaf || (kind === "file" ? !leaf.isFile() || leaf.nlink !== 1n : !leaf.isDirectory()) ||
      leaf.isSymbolicLink()) invalid();
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : leaf.uid;
  if (leaf.uid !== uid || (kind === "directory" && (leaf.mode & 0o077n) !== 0n)) invalid();
  return {
    realPath,
    kind,
    dev: leaf.dev,
    ino: leaf.ino,
    ctimeNs: leaf.ctimeNs,
    uid: leaf.uid,
    mode: leaf.mode & 0o777n,
    pathChain
  };
}

async function verifySkillScriptMountIdentity(frozen: FrozenSkillScriptMountIdentity | undefined) {
  if (!frozen) invalid();
  const current = await captureSkillScriptMountIdentity(frozen.realPath, frozen.kind);
  if (current.dev !== frozen.dev || current.ino !== frozen.ino || current.ctimeNs !== frozen.ctimeNs ||
      current.uid !== frozen.uid || current.mode !== frozen.mode || current.pathChain.length !== frozen.pathChain.length) {
    invalid();
  }
  for (let index = 0; index < current.pathChain.length; index += 1) {
    const left = current.pathChain[index]!;
    const right = frozen.pathChain[index]!;
    if (left.path !== right.path || left.dev !== right.dev || left.ino !== right.ino ||
        left.ctimeNs !== right.ctimeNs || left.uid !== right.uid || left.mode !== right.mode) {
      invalid();
    }
  }
}

function absolutePathChain(candidate: string) {
  const parsed = path.parse(candidate);
  const relative = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const chain = [parsed.root];
  let current = parsed.root;
  for (const segment of relative) {
    current = path.join(current, segment);
    chain.push(current);
  }
  return chain;
}

function assertProjectionRootIdentity(
  stat: BigIntStats,
  identity: ProjectionRootIdentity
) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev ||
      stat.ino !== identity.ino || stat.uid !== identity.uid) {
    throw scriptError("SKILL_SCRIPT_CLEANUP_FAILED");
  }
}

function missingOrThrow(error: unknown) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}

function scriptError(code: string) {
  const error = new Error(code);
  error.name = "SkillScriptError";
  return error;
}
