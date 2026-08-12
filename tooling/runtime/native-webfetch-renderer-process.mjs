import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function listNativeWebfetchRendererProcessGroups(options) {
  const workspaceId = String(options.workspaceId ?? "");
  if (!/^[a-f0-9]{16}$/u.test(workspaceId)) return [];
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,pgid=,command="], {
    maxBuffer: PROCESS_OUTPUT_BYTES
  });
  const rows = String(stdout).split(/\r?\n/u).map(parseProcessRow).filter(Boolean);
  const candidates = new Set(rows
    .filter((row) => isNativeWebfetchRendererCommand(row.command))
    .map((row) => row.processGroup));
  const groups = [];
  for (const processGroup of candidates) {
    if (!Number.isSafeInteger(processGroup) || processGroup <= 1) continue;
    const members = rows.filter((row) => row.processGroup === processGroup);
    const observed = await Promise.all(members.map(async (member) => ({
      ...member,
      signature: await processSignature(member.pid),
      workspaceMatches: await processEnvironmentMatches(
        member.pid,
        "SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID",
        workspaceId
      )
    })));
    groups.push(classifyNativeWebfetchRendererGroup(observed));
  }
  return groups
    .filter((group) => group.belongsToWorkspace)
    .sort((left, right) => left.processGroup - right.processGroup);
}

export async function stopNativeWebfetchRendererProcessGroups(options) {
  const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 5_000, 30_000));
  const verified = [];
  for (const candidate of options.groups) {
    if (!candidate.safeToSignal) {
      throw rendererProcessError(
        "WEBFETCH_RENDERER_PROCESS_IDENTITY_INVALID",
        `Native Renderer 进程组 ${candidate.processGroup} 缺少可验证身份；未发送停止信号。`
      );
    }
    const current = (await listNativeWebfetchRendererProcessGroups(options))
      .find((group) => group.processGroup === candidate.processGroup);
    if (!current) continue;
    if (!sameGroupIdentity(candidate, current) || !current.safeToSignal) {
      throw rendererProcessError(
        "WEBFETCH_RENDERER_PROCESS_IDENTITY_CHANGED",
        `Native Renderer 进程组 ${candidate.processGroup} 在停止前发生变化；未发送停止信号。`
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
      throw rendererProcessError(
        "WEBFETCH_RENDERER_PROCESS_IDENTITY_CHANGED",
        `Native Renderer 进程组 ${group.processGroup} 在停止期间发生变化；未发送 SIGKILL。`
      );
    }
    signalProcessGroup(group.processGroup, "SIGKILL");
  }
  await waitForGroupsToExit(options, survivors, 2_000);
  const alive = await matchingGroups(options, verified);
  if (alive.length > 0) {
    throw rendererProcessError(
      "WEBFETCH_RENDERER_PROCESS_STOP_TIMEOUT",
      `Native Renderer 进程组停止超时：${alive.map((item) => item.processGroup).join(", ")}。`
    );
  }
  return verified.map((item) => item.processGroup);
}

export function classifyNativeWebfetchRendererGroup(members) {
  const normalized = members.map((member) => ({
    pid: Number(member.pid),
    processGroup: Number(member.processGroup),
    signature: String(member.signature ?? ""),
    command: String(member.command ?? ""),
    workspaceMatches: member.workspaceMatches === true
  })).sort((left, right) => left.pid - right.pid);
  const processGroup = normalized[0]?.processGroup ?? 0;
  const hasRendererCommand = normalized.some((member) => isNativeWebfetchRendererCommand(member.command));
  const belongsToWorkspace = normalized.length > 0 && normalized.every((member) => member.workspaceMatches);
  return {
    processGroup,
    members: normalized,
    belongsToWorkspace,
    safeToSignal: Boolean(
      processGroup > 1
      && hasRendererCommand
      && belongsToWorkspace
      && normalized.every((member) => member.processGroup === processGroup && member.signature)
    )
  };
}

export function isNativeWebfetchRendererCommand(command) {
  const value = String(command ?? "");
  return /native-webfetch-renderer-supervisor\.mjs(?=$|\s)/u.test(value)
    || /dist\/apps\/webfetch-renderer\/main\.js(?=$|\s)/u.test(value);
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
  return (await listNativeWebfetchRendererProcessGroups(options))
    .filter((group) => expected.has(group.processGroup));
}

function sameGroupIdentity(left, right) {
  return Boolean(
    right
    && left.processGroup === right.processGroup
    && left.safeToSignal === right.safeToSignal
    && left.members.some((member) => right.members.some((current) => (
      member.pid === current.pid
      && member.signature === current.signature
      && member.workspaceMatches === current.workspaceMatches
    )))
  );
}

function parseProcessRow(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
  return match ? { pid: Number(match[1]), processGroup: Number(match[2]), command: match[3] } : null;
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

async function processEnvironmentMatches(pid, key, expected) {
  let output;
  try {
    const result = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "buffer",
      maxBuffer: PROCESS_OUTPUT_BYTES
    });
    output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const needle = Buffer.from(`${key}=${expected}`, "utf8");
    for (let offset = output.indexOf(needle); offset !== -1; offset = output.indexOf(needle, offset + 1)) {
      const before = offset === 0 ? 0x20 : output[offset - 1];
      const after = offset + needle.length >= output.length ? 0x20 : output[offset + needle.length];
      if (isAsciiWhitespace(before) && isAsciiWhitespace(after)) return true;
    }
    return false;
  } catch {
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

function rendererProcessError(code, detail) {
  const error = new Error(`${code}：${detail}`);
  error.code = code;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
