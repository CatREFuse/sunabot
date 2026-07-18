import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function listNativeCoreProcessGroups(options) {
  const root = path.resolve(options.root);
  const workspace = path.resolve(options.workspace);
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,pgid=,command="], {
    maxBuffer: PROCESS_OUTPUT_BYTES
  });
  const rows = String(stdout)
    .split(/\r?\n/u)
    .map(parseProcessRow)
    .filter(Boolean);
  const candidateGroups = new Set(rows
    .filter((row) => isNativeCoreCommand(row.command, root))
    .map((row) => row.processGroup));
  const groups = [];
  for (const processGroup of candidateGroups) {
    if (!Number.isInteger(processGroup) || processGroup <= 1) continue;
    const members = rows.filter((row) => row.processGroup === processGroup);
    const observed = await Promise.all(members.map(async (member) => ({
      ...member,
      signature: await processSignature(member.pid),
      environmentMatchesWorkspace: await processEnvironmentMatchesWorkspace(member.pid, workspace)
    })));
    groups.push(classifyNativeCoreGroup(observed, { root, workspace }));
  }
  return groups
    .filter((group) => group.belongsToWorkspace)
    .sort((left, right) => left.processGroup - right.processGroup);
}

export async function stopNativeCoreProcessGroups(options) {
  const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 5_000, 30_000));
  const verified = [];
  for (const candidate of options.groups) {
    if (!candidate.safeToSignal) {
      throw nativeCoreError(
        "NATIVE_CORE_PROCESS_IDENTITY_INVALID",
        `Native Core 进程组 ${candidate.processGroup} 缺少可验证的 workspace 身份；未发送停止信号。`
      );
    }
    const current = (await listNativeCoreProcessGroups(options))
      .find((group) => group.processGroup === candidate.processGroup);
    if (!current) continue;
    if (!sameGroupIdentity(candidate, current) || !current.safeToSignal) {
      throw nativeCoreError(
        "NATIVE_CORE_PROCESS_IDENTITY_CHANGED",
        `Native Core 进程组 ${candidate.processGroup} 在停止前发生变化；未发送停止信号。`
      );
    }
    verified.push(current);
  }

  for (const group of verified) signalProcessGroup(group.processGroup, "SIGTERM");
  await waitForGroupsToExit(options, verified, timeoutMs);

  const survivors = await matchingGroups(options, verified);
  for (const group of survivors) {
    const expected = verified.find((item) => item.processGroup === group.processGroup);
    if (!expected || !sameGroupIdentity(expected, group) || !group.safeToSignal) {
      throw nativeCoreError(
        "NATIVE_CORE_PROCESS_IDENTITY_CHANGED",
        `Native Core 进程组 ${group.processGroup} 在停止期间发生变化；未发送 SIGKILL。`
      );
    }
    signalProcessGroup(group.processGroup, "SIGKILL");
  }
  await waitForGroupsToExit(options, survivors, 2_000);
  const alive = await matchingGroups(options, verified);
  if (alive.length > 0) {
    throw nativeCoreError(
      "NATIVE_CORE_PROCESS_STOP_TIMEOUT",
      `Native Core 进程组停止超时：${alive.map((item) => item.processGroup).join(", ")}。`
    );
  }
  return verified.map((item) => item.processGroup);
}

export function classifyNativeCoreGroup(members, options) {
  const root = path.resolve(options.root);
  const normalized = members
    .map((member) => ({
      pid: Number(member.pid),
      processGroup: Number(member.processGroup),
      signature: String(member.signature ?? ""),
      command: String(member.command ?? ""),
      environmentMatchesWorkspace: member.environmentMatchesWorkspace === true
    }))
    .sort((left, right) => left.pid - right.pid);
  const processGroup = normalized[0]?.processGroup ?? 0;
  const hasCoreCommand = normalized.some((member) => isNativeCoreCommand(member.command, root));
  const belongsToWorkspace = normalized.length > 0
    && normalized.every((member) => member.environmentMatchesWorkspace);
  return {
    processGroup,
    members: normalized,
    belongsToWorkspace,
    safeToSignal: Boolean(
      processGroup > 1
      && hasCoreCommand
      && belongsToWorkspace
      && normalized.every((member) => member.processGroup === processGroup && member.signature)
    )
  };
}

export function isNativeCoreCommand(command, projectRoot) {
  const root = escapeRegExp(path.resolve(projectRoot));
  const value = String(command ?? "");
  return new RegExp(`${root}/dist/apps/api/main\\.js(?=$|\\s)`, "u").test(value)
    || new RegExp(`${root}/node_modules/[^\\s]*(?:tsx|vite|concurrently|esbuild)[^\\s]*`, "u").test(value)
    || /(?:^|\s)apps\/api\/main\.ts(?=$|\s)/u.test(value)
    || /(?:^|\s)apps\/admin-web\/vite\.config\.ts(?=$|\s)/u.test(value)
    || /^npm(?:\s+--[^\s]+)*\s+run\s+dev(?:\s|$)/u.test(value);
}

async function waitForGroupsToExit(options, groups, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await matchingGroups(options, groups)).length === 0) return;
    await delay(50);
  }
}

async function matchingGroups(options, groups) {
  if (groups.length === 0) return [];
  const expected = new Set(groups.map((group) => group.processGroup));
  return (await listNativeCoreProcessGroups(options))
    .filter((group) => expected.has(group.processGroup));
}

function sameGroupIdentity(left, right) {
  return Boolean(
    right
    && left.processGroup === right.processGroup
    && left.safeToSignal === right.safeToSignal
    && left.members.some((member) => right.members.some((current) => (
      member.pid === current.pid
      && member.processGroup === current.processGroup
      && member.signature === current.signature
      && member.environmentMatchesWorkspace === current.environmentMatchesWorkspace
    )))
  );
}

function parseProcessRow(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
  if (!match) return null;
  return { pid: Number(match[1]), processGroup: Number(match[2]), command: match[3] };
}

async function processSignature(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      maxBuffer: PROCESS_OUTPUT_BYTES
    });
    return String(stdout).trim();
  } catch {
    return "";
  }
}

async function processEnvironmentMatchesWorkspace(pid, workspace) {
  let output;
  try {
    const result = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "buffer",
      maxBuffer: PROCESS_OUTPUT_BYTES
    });
    output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const needle = Buffer.from(`SUNABOT_WORKSPACE=${workspace}`, "utf8");
    for (let offset = output.indexOf(needle); offset !== -1; offset = output.indexOf(needle, offset + 1)) {
      const before = offset === 0 ? 0x20 : output[offset - 1];
      const afterIndex = offset + needle.length;
      const after = afterIndex >= output.length ? 0x20 : output[afterIndex];
      if (isAsciiWhitespace(before) && isAsciiWhitespace(after)) return true;
    }
    return false;
  } catch (error) {
    if (Buffer.isBuffer(error?.stdout)) error.stdout.fill(0);
    if (Buffer.isBuffer(error?.stderr)) error.stderr.fill(0);
    return false;
  } finally {
    output?.fill(0);
  }
}

function signalProcessGroup(processGroup, signal) {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function isAsciiWhitespace(value) {
  return value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nativeCoreError(code, detail) {
  const error = new Error(`${code}：${detail}`);
  error.code = code;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
