#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const action = process.argv[2];
const key = process.argv[3];
const value = process.argv[4] ?? "";
if (action !== "set" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key ?? "")) {
  throw new Error("用法：workspace-env.mjs set VARIABLE VALUE");
}

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);
const envPath = path.join(workspace, ".env");
let lines = [];
try {
  lines = (await fs.readFile(envPath, "utf8")).split(/\r?\n/);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const assignment = `${key}=${encodeValue(value)}`;
let replaced = false;
lines = lines.map((line) => {
  if (!line.match(new RegExp(`^\\s*${key}=`))) return line;
  replaced = true;
  return assignment;
});
if (!replaced) lines.push(assignment);
while (lines.at(-1) === "") lines.pop();
await fs.mkdir(workspace, { recursive: true });
const temporary = `${envPath}.${process.pid}.${Date.now()}.tmp`;
await fs.writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
await fs.rename(temporary, envPath);
console.log(`${key} 已写入 workspace/.env（值已隐藏）。`);

function encodeValue(input) {
  if (!/[\s#'"\\]/.test(input)) return input;
  return JSON.stringify(input);
}
