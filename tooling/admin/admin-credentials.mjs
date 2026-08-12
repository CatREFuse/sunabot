#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import {
  assertMatchingAdminPasswords,
  createAdminCredentialRecord,
  normalizeAdminUsername,
  validateAdminPassword,
  writeAdminCredentialRecord
} from "./admin-credentials-core.mjs";

const projectRoot = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(projectRoot);
const credentialsPath = path.join(workspace, "secrets/admin-credentials.json");
const landing = process.argv[2] === "--landing";
if (landing && !process.stdin.isTTY) {
  throw new Error("首次启动需要交互终端，请在终端中重新执行 ./sunabot.sh up。");
}
const username = landing
  ? await readLandingUsername()
  : normalizeAdminUsername(process.argv[2] ?? "admin");
const password = landing
  ? await readLandingPassword()
  : validateAdminPassword(
      process.stdin.isTTY
        ? await readHidden("管理员密码（至少 12 个字符）：")
        : (await readStdin()).trimEnd()
    );

const now = new Date().toISOString();
let createdAt = now;
try {
  const previous = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  if (typeof previous.createdAt === "string") createdAt = previous.createdAt;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const record = await createAdminCredentialRecord({
  username,
  password,
  previous: { createdAt },
  now: new Date(now),
  randomBytes: crypto.randomBytes
});
await writeAdminCredentialRecord(credentialsPath, record);
console.log(`管理员凭据已更新：${credentialsPath}`);

async function readLandingUsername() {
  while (true) {
    try {
      return normalizeAdminUsername(await readVisible("管理员名称："));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function readLandingPassword() {
  while (true) {
    let password;
    try {
      password = validateAdminPassword(await readHidden("管理员密码（至少 12 个字符）："));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    const confirmation = await readHidden("确认管理员密码：");
    try {
      assertMatchingAdminPasswords(password, confirmation);
      return password;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function readVisible(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("已取消。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (!/^[\u0000-\u001f]$/.test(character)) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.setRawMode) return reject(new Error("当前终端不支持隐藏密码输入，请通过标准输入传入密码。"));
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("已取消。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (!/^[\u0000-\u001f]$/.test(character)) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
