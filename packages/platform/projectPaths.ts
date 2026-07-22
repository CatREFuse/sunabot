import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_LAYOUT } from "./workspaceLayout.js";

const rootDir = discoverProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
const workspaceDir = resolveWorkspaceDir(process.env.SUNABOT_WORKSPACE);

export function getRootDir() {
  return rootDir;
}

export function getWorkspaceDir() {
  return workspaceDir;
}

export function getWorkspacePath(...segments: string[]) {
  return path.join(workspaceDir, ...segments);
}

export function resolveProjectPath(inputPath: string | undefined) {
  if (!inputPath) return undefined;
  if (path.isAbsolute(inputPath)) return inputPath;
  const normalized = inputPath.replace(/\\/g, "/");
  if (normalized === ".env" || normalized === "workspace/.env") {
    return getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv);
  }
  if (normalized === "workspace") return workspaceDir;
  if (normalized === "workspace/agents" || normalized.startsWith("workspace/agents/")) {
    const suffix = normalized.slice("workspace/agents".length).replace(/^\/+/, "");
    return getWorkspacePath(WORKSPACE_LAYOUT.agentRoot, suffix);
  }
  if (normalized.startsWith("workspace/")) return getWorkspacePath(normalized.slice("workspace/".length));
  return path.join(rootDir, inputPath);
}

function resolveWorkspaceDir(configured: string | undefined) {
  const value = configured?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SUNABOT_WORKSPACE is required in production.");
    }
    return path.join(rootDir, "workspace");
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(rootDir, value);
}

function discoverProjectRoot(startDir: string) {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "AGENTS.md"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate sunabot project root from ${startDir}.`);
    }
    current = parent;
  }
}
