#!/usr/local/bin/node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 32 * 1024;
const INTERPRETERS = new Set(["/bin/bash", "/usr/bin/node"]);

try {
  const parsed = parseArguments(process.argv.slice(2));
  const manifestBytes = readPinnedFile("/skills/.sunabot-skill-script-manifest.json", 4 * 1024, 0o400);
  try {
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    if (!manifest || Object.keys(manifest).sort().join(",") !== "digestSha256,resource,schemaVersion,skillId" ||
        manifest.schemaVersion !== 1 || manifest.skillId !== parsed.skillId ||
        manifest.digestSha256 !== parsed.digest || !manifest.resource ||
        Object.keys(manifest.resource).sort().join(",") !== "bytes,path,sha256" ||
        manifest.resource.path !== parsed.resource || manifest.resource.bytes !== parsed.resourceBytes ||
        manifest.resource.sha256 !== parsed.resourceSha256) {
      invalid();
    }
  } finally {
    manifestBytes.fill(0);
  }
  const expected = `/skills/${parsed.skillId}/${parsed.resource}`;
  if (realpathSync(expected) !== expected) invalid();
  const before = lstatSync(expected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size !== BigInt(parsed.resourceBytes) || before.size > BigInt(MAX_SCRIPT_BYTES)) {
    invalid();
  }
  const handle = openSync(expected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content;
  try {
    const opened = fstatSync(handle, { bigint: true });
    if (!sameFile(before, opened)) invalid();
    content = Buffer.alloc(parsed.resourceBytes);
    let offset = 0;
    while (offset < content.length) {
      const bytes = readSync(handle, content, offset, content.length - offset, offset);
      if (bytes <= 0) invalid();
      offset += bytes;
    }
    const after = fstatSync(handle, { bigint: true });
    const pathAfter = lstatSync(expected, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, pathAfter) ||
        createHash("sha256").update(content).digest("hex") !== parsed.resourceSha256) {
      invalid();
    }
  } finally {
    content?.fill(0);
    closeSync(handle);
  }
  const child = spawn(parsed.interpreter, [expected, ...parsed.args], {
    cwd: "/workbench",
    env: {
      HOME: "/workbench",
      PWD: "/workbench",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp"
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      try { child.kill(signal); } catch { /* container cleanup remains authoritative */ }
    });
  }
  child.once("error", () => process.exit(125));
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} catch {
  process.exit(126);
}

function parseArguments(argv) {
  const values = new Map();
  let index = 0;
  for (const key of ["--skill", "--digest", "--resource", "--resource-sha256", "--resource-bytes", "--audit", "--interpreter"]) {
    if (argv[index] !== key || typeof argv[index + 1] !== "string") invalid();
    values.set(key, argv[index + 1]);
    index += 2;
  }
  if (argv[index] !== "--") invalid();
  const args = argv.slice(index + 1);
  const skillId = values.get("--skill");
  const digest = values.get("--digest");
  const resource = values.get("--resource");
  const resourceSha256 = values.get("--resource-sha256");
  const resourceBytes = Number(values.get("--resource-bytes"));
  const audit = values.get("--audit");
  const interpreter = values.get("--interpreter");
  if (!SAFE_ID.test(skillId) || !SHA256.test(digest) || !safeResource(resource) ||
      !SHA256.test(resourceSha256) || !Number.isSafeInteger(resourceBytes) || resourceBytes < 1 ||
      resourceBytes > MAX_SCRIPT_BYTES || !SHA256.test(audit) || !INTERPRETERS.has(interpreter) ||
      args.length > MAX_ARGS) {
    invalid();
  }
  let argumentBytes = 0;
  for (const value of args) {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid();
    argumentBytes += Buffer.byteLength(value, "utf8");
    if (Buffer.byteLength(value, "utf8") > 4_096 || argumentBytes > MAX_ARG_BYTES) invalid();
  }
  return { skillId, digest, resource, resourceSha256, resourceBytes, audit, interpreter, args };
}

function safeResource(value) {
  if (typeof value !== "string" || !value.startsWith("scripts/") || value.length > 1_024 ||
      value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..") &&
    [".sh", ".js"].includes(path.posix.extname(value).toLowerCase());
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function readPinnedFile(file, maximumBytes, mode) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n ||
      before.size > BigInt(maximumBytes) || Number(before.mode & 0o777n) !== mode) invalid();
  const handle = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content;
  try {
    const opened = fstatSync(handle, { bigint: true });
    if (!sameFile(before, opened)) invalid();
    content = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < content.length) {
      const bytes = readSync(handle, content, offset, content.length - offset, offset);
      if (bytes <= 0) invalid();
      offset += bytes;
    }
    const after = fstatSync(handle, { bigint: true });
    const pathAfter = lstatSync(file, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, pathAfter)) invalid();
    return content;
  } catch (error) {
    content?.fill(0);
    throw error;
  } finally {
    try {
      closeSync(handle);
    } catch (error) {
      content?.fill(0);
      throw error;
    }
  }
}

function invalid() {
  throw new Error("SKILL_SCRIPT_ENTRYPOINT_INVALID");
}
