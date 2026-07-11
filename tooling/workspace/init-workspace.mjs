#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);

await Promise.all([
  "business/agents/plana/selfie",
  "business/config",
  "business/data",
  "business/media/images",
  "cache/attachments",
  "backups",
  "runtime/logs",
  "runtime/napcat/config-full",
  "runtime/tmp",
  "secrets"
].map((directory) => fs.mkdir(path.join(workspace, directory), { recursive: true })));

await copyIfMissing(path.join(root, "config/env.example"), path.join(workspace, "secrets/runtime.env"));
console.log(`workspace 已准备：${workspace}`);
console.log("下一步：npm run admin:set-password -- <管理员账号>");

async function copyIfMissing(source, destination) {
  try {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
