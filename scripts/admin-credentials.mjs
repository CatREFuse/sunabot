#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const workspace = resolveWorkspace();
const credentialsPath = path.join(workspace, "security/admin-credentials.json");
const username = String(process.argv[2] ?? "admin").trim();

if (!/^[A-Za-z0-9._-]{1,128}$/.test(username)) {
  throw new Error("管理员账号只能包含字母、数字、点、下划线和短横线。");
}

const password = process.stdin.isTTY ? await readHidden("管理员密码（至少 12 个字符）：") : (await readStdin()).trimEnd();
if (password.length < 12) throw new Error("管理员密码至少需要 12 个字符。");
if (password.length > 1024) throw new Error("管理员密码过长。");

const now = new Date().toISOString();
let createdAt = now;
try {
  const previous = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  if (typeof previous.createdAt === "string") createdAt = previous.createdAt;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const salt = crypto.randomBytes(16).toString("base64url");
const keyLength = 64;
const derived = await scrypt(password, salt, keyLength, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const record = {
  version: 1,
  username,
  password: { algorithm: "scrypt", salt, hash: Buffer.from(derived).toString("base64url"), keyLength },
  createdAt,
  updatedAt: now
};
await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
const temporary = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await fs.rename(temporary, credentialsPath);
console.log(`管理员凭据已更新：${credentialsPath}`);

function resolveWorkspace() {
  const configured = process.env.SUNABOT_WORKSPACE?.trim();
  if (!configured) return path.join(process.cwd(), "workspace");
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(process.cwd(), configured);
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
