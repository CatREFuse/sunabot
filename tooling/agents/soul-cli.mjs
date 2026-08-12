#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const FILE_EXTENSION = ".sunabot-soul.json";
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const configuredBaseUrl = process.env.SUNABOT_ADMIN_URL?.trim() || "http://127.0.0.1:8787";
let baseUrl = "";

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === "help") return printHelp();
  baseUrl = localAdminUrl(configuredBaseUrl);
  const session = await login(options.username);
  if (options.command === "export") return exportSoul(options, session);
  const upload = await readUpload(options.input);
  const preview = await requestJson(
    `/api/agents/${encodeURIComponent(options.agent)}/soul/preview`,
    { method: "POST", body: JSON.stringify(upload) },
    session
  );
  printPreview(preview);
  if (options.command === "inspect") return;
  if (!options.yes) await confirmImport();
  const result = await requestJson(
    `/api/agents/${encodeURIComponent(options.agent)}/soul/import`,
    {
      method: "POST",
      body: JSON.stringify({
        ...upload,
        packageSha256: preview.packageSha256,
        targetRevision: preview.targetRevision
      })
    },
    session
  );
  process.stdout.write(`已导入 ${result.imported} 个文件。\n`);
}

function parseArguments(argv) {
  const values = [...argv];
  const command = values.shift() || "help";
  if (command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (!new Set(["export", "inspect", "import"]).has(command)) throw new Error(`未知灵魂文件命令：${command}`);
  const options = { command, agent: "", input: "", output: "", username: "", yes: false };
  while (values.length) {
    const argument = values.shift();
    if (argument === "--yes") {
      options.yes = true;
      continue;
    }
    const match = argument?.match(/^--(agent|input|output|username)(?:=(.*))?$/);
    if (!match) throw new Error(`不支持的参数：${argument}`);
    const value = match[2] ?? values.shift() ?? "";
    if (!value) throw new Error(`--${match[1]} 不能为空。`);
    options[match[1]] = value;
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(options.agent)) throw new Error("--agent 需要合法的 Agent ID。");
  if (command === "export") {
    if (!options.output) throw new Error("export 需要 --output 路径。");
    if (!options.output.endsWith(FILE_EXTENSION)) throw new Error(`--output 必须以 ${FILE_EXTENSION} 结尾。`);
    if (options.input) throw new Error("export 不支持 --input。");
  } else {
    if (!options.input) throw new Error(`${command} 需要 --input 路径。`);
    if (!options.input.endsWith(FILE_EXTENSION)) throw new Error(`--input 必须以 ${FILE_EXTENSION} 结尾。`);
    if (options.output) throw new Error(`${command} 不支持 --output。`);
  }
  if (command !== "import" && options.yes) throw new Error("--yes 仅支持 import。");
  return options;
}

async function login(configuredUsername) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("管理 API 登录需要交互式终端。");
  }
  const username = configuredUsername || await readLine("管理员名称：");
  if (!username.trim()) throw new Error("管理员名称不能为空。");
  const password = await readSecret("管理员密码：");
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username: username.trim(), password })
  });
  if (!response.ok) throw await responseError(response);
  const body = await response.json();
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  if (!body.csrfToken || !cookie) throw new Error("管理 API 登录会话无效。");
  return { cookie, csrfToken: body.csrfToken };
}

async function exportSoul(options, session) {
  const response = await request(
    `/api/agents/${encodeURIComponent(options.agent)}/soul/export`,
    { method: "GET" },
    session
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error("管理 API 返回的灵魂文件大小无效。");
  const output = path.resolve(options.output);
  await fs.writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  process.stdout.write(`灵魂文件已导出：${output}\n`);
}

async function readUpload(inputPath) {
  const resolved = path.resolve(inputPath);
  const bytes = await fs.readFile(resolved);
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error("灵魂文件必须小于 3 MiB。");
  return { fileName: path.basename(resolved), dataBase64: bytes.toString("base64") };
}

async function requestJson(resource, init, session) {
  return (await request(resource, init, session)).json();
}

async function request(resource, init, session) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cookie", session.cookie);
  if (init.body != null) headers.set("content-type", "application/json");
  if (init.method && !new Set(["GET", "HEAD", "OPTIONS"]).has(init.method.toUpperCase())) {
    headers.set("x-sunabot-csrf", session.csrfToken);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${resource}`, { ...init, headers });
  } catch {
    throw new Error(`无法连接本机管理 API：${baseUrl}`);
  }
  if (!response.ok) throw await responseError(response);
  return response;
}

async function responseError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return new Error(`管理 API 请求失败（${response.status}）。`);
  }
  return new Error(typeof body.message === "string" ? body.message : `管理 API 请求失败（${response.status}）。`);
}

function printPreview(preview) {
  const changed = preview.files.filter((file) => file.change === "replace").length;
  process.stdout.write(`来源：${preview.source.name} (${preview.source.agentId})\n`);
  process.stdout.write(`目标：${preview.targetAgentId}\n`);
  process.stdout.write(`文件：${preview.files.length}，更新：${changed}\n`);
  for (const file of preview.files) {
    process.stdout.write(`${file.change === "replace" ? "更新" : "不变"}\t${file.id}\t${file.fileName}\n`);
  }
}

async function confirmImport() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("非交互导入需要 --yes。");
  const answer = await readLine("输入 IMPORT 确认导入：");
  if (answer !== "IMPORT") throw new Error("已取消导入。");
}

async function readLine(prompt) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("已取消。"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}

function printHelp() {
  process.stdout.write([
    "用法：",
    "  node tooling/agents/soul-cli.mjs export --agent <id> --output <file.sunabot-soul.json> [--username <name>]",
    "  node tooling/agents/soul-cli.mjs inspect --agent <id> --input <file.sunabot-soul.json> [--username <name>]",
    "  node tooling/agents/soul-cli.mjs import --agent <id> --input <file.sunabot-soul.json> [--username <name>] [--yes]",
    "",
    "密码仅通过交互式终端读取。",
    ""
  ].join("\n"));
}

function localAdminUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("SUNABOT_ADMIN_URL 无效。");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(hostname)
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new Error("SUNABOT_ADMIN_URL 必须是本机回环管理地址。");
  }
  return url.origin;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
