#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const action = process.argv[2] ?? "status";
const projectRoot = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(projectRoot);
const fusePath = path.join(workspace, "secrets/ADMIN_DISABLED.json");

if (action === "trip") {
  await fs.mkdir(path.dirname(fusePath), { recursive: true });
  const temporary = `${fusePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ trippedAt: new Date().toISOString(), reason: process.argv[3] ?? "cli-emergency" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, fusePath);
  console.log("远程管理入口已熔断。");
} else if (action === "reset") {
  await fs.rm(fusePath, { force: true });
  console.log("远程管理入口熔断已解除。");
} else if (action === "status") {
  try {
    console.log(await fs.readFile(fusePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("远程管理入口未手动熔断。");
  }
} else {
  throw new Error("用法：admin-fuse.mjs status|trip [reason]|reset");
}
