import fs from "node:fs/promises";
import path from "node:path";

export const AGENT_WORKBENCH_DIRECTORY = "workbench";

export async function resolveAgentWorkbench(agentWorkspace: string) {
  const workspace = path.resolve(agentWorkspace);
  const workspaceRoot = await resolveWorkspaceRoot(workspace);
  const workbenchPath = path.join(workspaceRoot, AGENT_WORKBENCH_DIRECTORY);
  await fs.mkdir(workbenchPath, { recursive: true });
  const stat = await fs.lstat(workbenchPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("AGENT_WORKBENCH_INVALID: workbench must be a regular directory.");
  }
  const workbenchRoot = await fs.realpath(workbenchPath);
  assertWithin(workspaceRoot, workbenchRoot, "AGENT_WORKBENCH_INVALID");
  return workbenchRoot;
}

export async function resolveAgentWorkbenchFile(agentWorkspace: string, relativePath: string) {
  const requested = relativePath.trim();
  if (!requested || path.isAbsolute(requested)) {
    throw new Error("AGENT_WORKBENCH_PATH_INVALID: path must be relative to workbench.");
  }
  const workbenchRoot = await resolveAgentWorkbench(agentWorkspace);
  const candidate = path.resolve(workbenchRoot, requested);
  assertWithin(workbenchRoot, candidate, "AGENT_WORKBENCH_PATH_INVALID");
  const resolved = await fs.realpath(candidate);
  assertWithin(workbenchRoot, resolved, "AGENT_WORKBENCH_PATH_INVALID");
  return resolved;
}

async function resolveWorkspaceRoot(workspace: string) {
  const existingWorkspace = await lstatIfPresent(workspace);
  if (existingWorkspace) {
    assertRegularDirectory(existingWorkspace, "Agent workspace");
    return fs.realpath(workspace);
  }

  const parent = await findExistingParent(workspace);
  const parentStat = await fs.lstat(parent);
  assertRegularDirectory(parentStat, "Agent workspace parent");
  const parentRoot = await fs.realpath(parent);
  const relativeWorkspace = path.relative(parent, workspace);
  if (!relativeWorkspace || relativeWorkspace === ".." || relativeWorkspace.startsWith(`..${path.sep}`)) {
    throw new Error("AGENT_WORKBENCH_INVALID: Agent workspace parent is invalid.");
  }

  const workspaceRoot = path.join(parentRoot, relativeWorkspace);
  await fs.mkdir(workspaceRoot, { recursive: true });
  await assertDirectoryChain(parentRoot, relativeWorkspace);
  return fs.realpath(workspaceRoot);
}

async function findExistingParent(candidate: string) {
  let current = path.dirname(candidate);
  while (!(await lstatIfPresent(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("AGENT_WORKBENCH_INVALID: Agent workspace parent does not exist.");
    }
    current = parent;
  }
  return current;
}

async function assertDirectoryChain(root: string, relativePath: string) {
  let current = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    assertRegularDirectory(stat, "Agent workspace path");
  }
}

function assertRegularDirectory(stat: { isDirectory(): boolean; isSymbolicLink(): boolean }, label: string) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`AGENT_WORKBENCH_INVALID: ${label} must be a regular directory.`);
  }
}

async function lstatIfPresent(candidate: string) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertWithin(root: string, candidate: string, code: string) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${code}: path escapes the current Agent workbench.`);
}
