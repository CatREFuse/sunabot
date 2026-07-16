import fs from "node:fs/promises";
import path from "node:path";
import type {
  BashApprovalAccess,
  BashPathAccess,
  BashPathChainIdentity
} from "./bashAudit.js";
import type { RestrictedPathOperand, RestrictedPathRole } from "./bashPolicy.js";

export interface FrozenFilesystemIdentity {
  path: string;
  device: string;
  inode: string;
  owner: string;
  mode: string;
  links: string;
  kind: "file" | "directory";
  pathChain: BashPathChainIdentity[];
}

export interface FrozenRestrictedPath {
  workbenchRoot: string;
  targetPath: string;
  role: RestrictedPathRole;
  target?: FrozenFilesystemIdentity;
  parent?: FrozenFilesystemIdentity;
  expectedMissing: boolean;
}

export async function captureWorkbenchIdentity(workbenchRoot: string) {
  const frozen = await captureFilesystemIdentity(workbenchRoot, "directory");
  if (frozen.path !== workbenchRoot) throw new Error("workbench path is not canonical");
  return frozen;
}

export async function prepareRestrictedPaths(
  operands: RestrictedPathOperand[],
  workbenchRoot: string
) {
  const frozen: FrozenRestrictedPath[] = [];
  for (const operand of operands) {
    const targetPath = path.resolve(workbenchRoot, operand.path);
    if (!isWithinPath(workbenchRoot, targetPath)) throw new Error("restricted operand escapes workbench");
    const expectedKind = restrictedExistingKind(operand.role);
    try {
      await fs.lstat(targetPath);
      frozen.push({
        workbenchRoot,
        targetPath,
        role: operand.role,
        target: validateRestrictedFilesystemIdentity(
          await captureFilesystemIdentity(targetPath, expectedKind),
          workbenchRoot
        ),
        expectedMissing: false
      });
    } catch (error) {
      if (!isMissingPathError(error) || !restrictedRoleAllowsMissingLeaf(operand.role)) throw error;
      const parentPath = path.dirname(targetPath);
      if (parentPath === targetPath || !isWithinPath(workbenchRoot, parentPath)) {
        throw new Error("restricted target parent escapes workbench");
      }
      frozen.push({
        workbenchRoot,
        targetPath,
        role: operand.role,
        parent: validateRestrictedFilesystemIdentity(
          await captureFilesystemIdentity(parentPath, "directory"),
          workbenchRoot
        ),
        expectedMissing: true
      });
    }
  }
  for (const entry of frozen) {
    if (entry.target?.kind === "file" && entry.target.links !== "1") {
      throw new Error("restricted regular file has multiple hard links");
    }
  }
  return frozen;
}

export async function verifyRestrictedPaths(paths: FrozenRestrictedPath[]) {
  for (const frozen of paths) {
    if (frozen.expectedMissing) {
      if (!frozen.parent) throw new Error("restricted parent identity is missing");
      validateRestrictedFilesystemIdentity(
        await verifyFrozenFilesystemIdentity(frozen.parent, "directory"),
        frozen.workbenchRoot
      );
      try {
        await fs.lstat(frozen.targetPath);
        throw new Error("restricted missing leaf appeared before execution");
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      continue;
    }
    if (!frozen.target) throw new Error("restricted target identity is missing");
    const current = await verifyFrozenFilesystemIdentity(
      frozen.target,
      restrictedExistingKind(frozen.role)
    );
    validateRestrictedFilesystemIdentity(current, frozen.workbenchRoot);
    if (current.kind === "file" && current.links !== "1") {
      throw new Error("restricted regular file gained a hard link");
    }
  }
}

export async function prepareOutsideApprovalAccesses(
  accesses: BashPathAccess[],
  workbenchRoot: string
): Promise<BashApprovalAccess[]> {
  const prepared: BashApprovalAccess[] = [];
  const seen = new Set<string>();
  for (const access of accesses) {
    if (access.access !== "read") throw new Error("outside approval is read-only");
    const frozen = await captureFilesystemIdentity(access.path, "file");
    validateOutsideApprovalPath(frozen.path, workbenchRoot);
    validateOutsideApprovalIdentity(frozen);
    const key = `${access.access}\0${frozen.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prepared.push({
      path: frozen.path,
      access: access.access,
      identity: {
        device: frozen.device,
        inode: frozen.inode,
        owner: frozen.owner,
        mode: frozen.mode,
        links: frozen.links
      },
      pathChain: frozen.pathChain
    });
  }
  if (!prepared.length) throw new Error("approval has no concrete path");
  return prepared;
}

export async function verifyApprovalAccesses(
  accesses: BashApprovalAccess[],
  workbenchRoot: string
) {
  if (!accesses.length) throw new Error("approval has no path identity");
  for (const access of accesses) {
    if (access.access !== "read") throw new Error("approval access is not read-only");
    if (!access.identity || !access.pathChain?.length) throw new Error("approval identity is missing");
    validateOutsideApprovalPath(access.path, workbenchRoot);
    const current = await verifyFrozenFilesystemIdentity({
      path: access.path,
      device: access.identity.device,
      inode: access.identity.inode,
      owner: access.identity.owner,
      mode: access.identity.mode,
      links: access.identity.links ?? "",
      kind: "file",
      pathChain: access.pathChain
    }, "file");
    validateOutsideApprovalIdentity(current);
  }
}

export async function verifyFrozenFilesystemIdentity(
  frozen: FrozenFilesystemIdentity,
  expectedKind: "file" | "directory" | "any"
) {
  const current = await captureFilesystemIdentity(frozen.path, expectedKind);
  if (
    current.device !== frozen.device
    || current.inode !== frozen.inode
    || current.owner !== frozen.owner
    || current.mode !== frozen.mode
    || (frozen.kind === "file" && current.links !== frozen.links)
  ) {
    throw new Error("path object identity changed");
  }
  if (current.pathChain.length !== frozen.pathChain.length) throw new Error("path chain identity changed");
  for (let index = 0; index < current.pathChain.length; index += 1) {
    const currentPart = current.pathChain[index]!;
    const frozenPart = frozen.pathChain[index]!;
    if (
      currentPart.path !== frozenPart.path
      || currentPart.device !== frozenPart.device
      || currentPart.inode !== frozenPart.inode
      || currentPart.owner !== frozenPart.owner
      || currentPart.mode !== frozenPart.mode
    ) {
      throw new Error("path chain identity changed");
    }
  }
  return current;
}

async function captureFilesystemIdentity(
  candidate: string,
  expectedKind: "file" | "directory" | "any"
): Promise<FrozenFilesystemIdentity> {
  if (!candidate || !path.isAbsolute(candidate) || /[\u0000\r\n]/.test(candidate)) {
    throw new Error("path is not absolute");
  }
  const canonical = path.resolve(candidate);
  if (canonical !== candidate || canonical === "/") throw new Error("path is not canonical");
  const beforeRealPath = await fs.realpath(canonical);
  if (beforeRealPath !== canonical) throw new Error("path resolves through an alias");

  const chainPaths = absolutePathChain(canonical);
  const pathChain: BashPathChainIdentity[] = [];
  let leafKind: "file" | "directory" | "unsupported" = "unsupported";
  let leafLinks = "";
  for (let index = 0; index < chainPaths.length; index += 1) {
    const chainPath = chainPaths[index]!;
    const stat = await fs.lstat(chainPath);
    if (stat.isSymbolicLink()) throw new Error("path chain contains a symlink");
    const isLeaf = index === chainPaths.length - 1;
    if (!isLeaf && !stat.isDirectory()) throw new Error("path parent is not a directory");
    if (isLeaf) {
      leafKind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "unsupported";
      leafLinks = String(stat.nlink);
    }
    pathChain.push({
      path: chainPath,
      device: String(stat.dev),
      inode: String(stat.ino),
      owner: String(stat.uid),
      mode: (stat.mode & 0o7777).toString(8)
    });
  }
  if (leafKind === "unsupported" || (expectedKind !== "any" && leafKind !== expectedKind)) {
    throw new Error("path type is not allowed");
  }
  const afterRealPath = await fs.realpath(canonical);
  if (afterRealPath !== canonical) throw new Error("path identity changed while resolving");
  const leaf = pathChain.at(-1)!;
  return {
    path: canonical,
    device: leaf.device,
    inode: leaf.inode,
    owner: leaf.owner,
    mode: leaf.mode,
    links: leafLinks,
    kind: leafKind,
    pathChain
  };
}

function validateRestrictedFilesystemIdentity(
  frozen: FrozenFilesystemIdentity,
  workbenchRoot: string
) {
  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (effectiveUid <= 0) throw new Error("restricted paths require a non-root Core user");
  const workbenchIndex = frozen.pathChain.findIndex((part) => part.path === workbenchRoot);
  if (workbenchIndex < 0) throw new Error("restricted path does not include the workbench root");
  const lastDirectoryIndex = frozen.kind === "directory"
    ? frozen.pathChain.length - 1
    : frozen.pathChain.length - 2;
  for (let index = workbenchIndex; index <= lastDirectoryIndex; index += 1) {
    const part = frozen.pathChain[index]!;
    const owner = Number(part.owner);
    const mode = Number.parseInt(part.mode, 8);
    if (owner !== effectiveUid || !Number.isSafeInteger(mode)) {
      throw new Error("restricted path directory owner is not trusted");
    }
    if ((mode & 0o022) !== 0 || (mode & 0o1000) !== 0) {
      throw new Error("restricted path directory is writable by another principal");
    }
  }
  return frozen;
}

function restrictedExistingKind(role: RestrictedPathRole): "file" | "directory" | "any" {
  if (role === "read-entry") return "any";
  if (role === "create-directory" || role === "delete-directory") return "directory";
  return "file";
}

function restrictedRoleAllowsMissingLeaf(role: RestrictedPathRole) {
  return role === "write-file" || role === "create-directory";
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function absolutePathChain(candidate: string) {
  const root = path.parse(candidate).root;
  const result = [root];
  let current = root;
  for (const segment of candidate.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    result.push(current);
  }
  return result;
}

function validateOutsideApprovalPath(candidate: string, workbenchRoot: string) {
  const segments = candidate.split(path.sep).filter(Boolean);
  if (
    candidate === "/"
    || segments.length < 2
    || isWithinPath(candidate, workbenchRoot)
    || isWithinPath(workbenchRoot, candidate)
  ) {
    throw new Error("outside approval path is overbroad or overlaps the workbench");
  }
}

function validateOutsideApprovalIdentity(frozen: FrozenFilesystemIdentity) {
  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (effectiveUid <= 0) throw new Error("outside approval requires a non-root Core user");
  if (["/proc", "/sys", "/dev"].some((reservedRoot) => isWithinPath(reservedRoot, frozen.path))) {
    throw new Error("outside approval path uses a kernel or device tree");
  }
  for (const part of frozen.pathChain) {
    const owner = Number(part.owner);
    const mode = Number.parseInt(part.mode, 8);
    if ((owner !== 0 && owner !== effectiveUid) || !Number.isSafeInteger(mode)) {
      throw new Error("outside approval path owner is not trusted");
    }
    if ((mode & 0o022) !== 0 || (mode & 0o1000) !== 0) {
      throw new Error("outside approval path chain is writable by another principal");
    }
  }
}

function isWithinPath(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}
