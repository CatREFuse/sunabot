import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{16}$/u;

export async function removeLegacyVoiceContainers(options) {
  const workspaceId = String(options?.workspaceId ?? "");
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("旧语音容器 workspace 标识无效。");
  }
  const run = options?.execFile ?? execFileAsync;
  const timeoutSeconds = boundedTimeout(options?.timeoutSeconds);
  let containers = await listLegacyVoiceContainers(run, workspaceId);
  if (containers.length === 0) return false;
  if (containers.some((container) => container.component !== "voice")) {
    throw new Error("发现归属标记冲突的旧语音容器，已拒绝清理。");
  }

  const ids = containers.map((container) => container.id);
  await run(
    "docker",
    ["stop", "--timeout", String(timeoutSeconds), ...ids],
    commandOptions((timeoutSeconds + 5) * 1_000),
  );
  containers = await listLegacyVoiceContainers(run, workspaceId);
  if (containers.some((container) => container.state === "running")) {
    throw new Error("旧语音容器未能停止。");
  }
  if (containers.length > 0) {
    await run(
      "docker",
      ["rm", ...containers.map((container) => container.id)],
      commandOptions(30_000),
    );
  }
  if ((await listLegacyVoiceContainers(run, workspaceId)).length > 0) {
    throw new Error("旧语音容器未能移除。");
  }
  return true;
}

async function listLegacyVoiceContainers(run, workspaceId) {
  const result = await run(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=io.sunabot.voice-workspace-id=${workspaceId}`,
      "--format",
      ["{{.ID}}", '{{.Label "io.sunabot.component"}}', "{{.State}}"].join("\t"),
    ],
    commandOptions(15_000),
  );
  return String(result.stdout ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [id = "", component = "", state = ""] = line.split("\t");
      if (!/^[a-f0-9]{12,64}$/u.test(id)) {
        throw new Error("旧语音容器身份无效。");
      }
      return { id, component, state: state.toLowerCase() };
    });
}

function boundedTimeout(value) {
  const timeout = Number(value ?? 20);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("旧语音容器停止时限无效。");
  }
  return timeout;
}

function commandOptions(timeout) {
  return { maxBuffer: PROCESS_OUTPUT_BYTES, timeout };
}
