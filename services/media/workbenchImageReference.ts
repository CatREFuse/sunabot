import path from "node:path";
import { resolveAgentWorkbench } from "../agents/public.js";

export interface WorkbenchImageReferenceAddress {
  path: string;
}

const VIRTUAL_WORKBENCH_ROOT = "/workbench";

export async function resolveWorkbenchImageReferenceAddress(
  agentWorkspace: string,
  requestedPath: string
): Promise<WorkbenchImageReferenceAddress> {
  const requested = requestedPath.trim();
  if (!requested) throw invalidWorkbenchImagePath();

  const virtualPath = virtualWorkbenchRelative(VIRTUAL_WORKBENCH_ROOT, requested);
  if (virtualPath !== undefined) {
    if (virtualPath === OBSOLETE_NATIVE_PROJECTION || virtualPath.startsWith(`${OBSOLETE_NATIVE_PROJECTION}${path.sep}`)) {
      throw outsideAuthorizedWorkbench();
    }
    return {
      path: virtualPath
    };
  }

  if (!path.isAbsolute(requested)) {
    const normalized = path.posix.normalize(requested);
    if (normalized === "knowledge" || normalized.startsWith("knowledge/")) {
      if (normalized === "knowledge" || normalized.includes("../")) throw outsideAuthorizedWorkbench();
      return {
        path: normalized.split("/").join(path.sep)
      };
    }
    return {
      path: requested
    };
  }

  const root = await resolveAgentWorkbench(agentWorkspace);
  const relativePath = physicalWorkbenchRelative(root, requested);
  if (relativePath !== undefined) {
    return {
      path: relativePath
    };
  }
  throw outsideAuthorizedWorkbench();
}

const OBSOLETE_NATIVE_PROJECTION = "native-workbench";

function virtualWorkbenchRelative(root: string, candidate: string) {
  if (candidate !== root && !candidate.startsWith(`${root}/`)) return undefined;
  const relative = path.posix.relative(root, path.posix.normalize(candidate));
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw outsideAuthorizedWorkbench();
  }
  return relative.split("/").join(path.sep);
}

function physicalWorkbenchRelative(root: string, candidate: string) {
  const relative = path.relative(root, path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function invalidWorkbenchImagePath() {
  return new Error("WORKBENCH_IMAGE_PATH_INVALID");
}

function outsideAuthorizedWorkbench() {
  return new Error("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
}
