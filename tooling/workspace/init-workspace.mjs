#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareFreshInstallMarker } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const WORKSPACE_DIRECTORIES = [
  "business/agents/plana/workbench/selfie",
  "business/config",
  "business/data",
  "business/media/images",
  "cache/attachments",
  "backups",
  "runtime/logs",
  "runtime/napcat/accounts",
  "runtime/tmp",
  "secrets"
];

export async function initializeWorkspace(options = {}) {
  const root = options.root ?? resolveProjectRoot(import.meta.url);
  const requestedWorkspace = options.workspace ?? resolveWorkspace(root);
  const { workspace } = await prepareFreshInstallMarker(requestedWorkspace, options.now);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.chmod(workspace, 0o700);
  await Promise.all(workspaceDirectoryHierarchy().map(async (directory) => {
    const target = path.join(workspace, directory);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.chmod(target, 0o700);
  }));

  const runtimeEnv = path.join(workspace, "secrets/runtime.env");
  await copyIfMissing(path.join(root, "config/env.example"), runtimeEnv);
  await fs.chmod(runtimeEnv, 0o600);
  return { root, workspace, runtimeEnv };
}

function workspaceDirectoryHierarchy() {
  const directories = new Set();
  for (const leaf of WORKSPACE_DIRECTORIES) {
    let current = leaf;
    while (current !== ".") {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return [...directories].sort((left, right) => left.split("/").length - right.split("/").length);
}

async function copyIfMissing(source, destination) {
  try {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await initializeWorkspace();
  console.log(`workspace 已准备：${result.workspace}`);
  console.log("下一步：npm run admin:set-password -- <管理员账号>");
}
