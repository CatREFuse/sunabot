import path from "node:path";
import { resolveAgentWorkbench } from "../agents/public.js";

export interface WorkbenchImageReferenceAddress {
  path: string;
  backend: "native" | "docker";
  exactBackend: boolean;
}

const DOCKER_WORKBENCH_ROOT = "/workbench";
const DOCKER_NATIVE_PROJECTION_ROOT = "/workbench/native-workbench";

export async function resolveWorkbenchImageReferenceAddress(
  agentWorkspace: string,
  conversationBackend: "native" | "docker",
  requestedPath: string
): Promise<WorkbenchImageReferenceAddress> {
  const requested = requestedPath.trim();
  if (!requested) throw invalidWorkbenchImagePath();

  const nativeProjectionPath = virtualWorkbenchRelative(
    DOCKER_NATIVE_PROJECTION_ROOT,
    requested
  );
  if (nativeProjectionPath !== undefined) {
    return {
      path: nativeProjectionPath,
      backend: "native",
      exactBackend: true
    };
  }

  const dockerPath = virtualWorkbenchRelative(DOCKER_WORKBENCH_ROOT, requested);
  if (dockerPath !== undefined) {
    return {
      path: dockerPath,
      backend: "docker",
      exactBackend: true
    };
  }

  if (!path.isAbsolute(requested)) {
    return {
      path: requested,
      backend: conversationBackend,
      exactBackend: false
    };
  }

  const allowedBackends = conversationBackend === "native"
    ? (["native", "docker"] as const)
    : (["docker"] as const);
  for (const backend of allowedBackends) {
    const root = await resolveAgentWorkbench(agentWorkspace, backend);
    const relativePath = physicalWorkbenchRelative(root, requested);
    if (relativePath !== undefined) {
      return {
        path: relativePath,
        backend,
        exactBackend: true
      };
    }
  }
  throw outsideAuthorizedWorkbench();
}

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
