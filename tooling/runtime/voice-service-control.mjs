#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { workspaceIdentity } from "./launcher-core.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const execFileAsync = promisify(execFile);
const root = resolveProjectRoot(import.meta.url);
const ACTIONS = new Set(["check", "start", "stop"]);
const COMPONENT_LABEL = "io.sunabot.component";
const WORKSPACE_LABEL = "io.sunabot.voice-workspace-id";
const PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export class VoiceServiceHostError extends Error {
  constructor(code, message, status = 503, internalMessage = "") {
    super(message);
    this.name = "VoiceServiceHostError";
    this.code = code;
    this.status = status;
    this.internalMessage = internalMessage;
  }
}

export async function controlVoiceService(action, options = {}) {
  if (!ACTIONS.has(action)) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_ACTION_INVALID",
      "语音服务操作无效。",
      409,
    );
  }
  const host = voiceServiceHostContext(options);
  const { environment, workspace, identity, container, network, run } = host;
  const image = String(
    environment.SUNABOT_MOSS_TTS_NANO_IMAGE ??
      "sunabot-moss-tts-nano:9b1d3eadd5a7",
  ).trim();

  await requireDocker(run);
  const current = await inspectVoiceContainer(run, container);
  assertContainerOwnership(current, identity);
  if (action === "check") return runtimeStatus(current);
  if (action === "stop") {
    if (!current) return runtimeStatus(null);
    if (current.State?.Running === true) {
      await runDocker(run, ["stop", "--time", "15", container]);
    }
    const remaining = await inspectVoiceContainer(run, container);
    assertContainerOwnership(remaining, identity);
    if (remaining) await removeVoiceContainer(run, container);
    return runtimeStatus(null);
  }
  if (current?.State?.Running === true) return runtimeStatus(current);
  if (current) await removeVoiceContainer(run, container);
  await requireDockerObject(
    run,
    ["image", "inspect", image],
    "VOICE_SERVICE_IMAGE_MISSING",
    "语音服务镜像未安装，请在主机完成语音服务安装。",
  );
  await requireDockerObject(
    run,
    ["network", "inspect", network],
    "VOICE_SERVICE_NETWORK_UNAVAILABLE",
    "语音服务运行网络不可用，请重启 Sunabot。",
  );
  try {
    await run(
      "bash",
      [path.join(root, "tools/start_moss_tts_nano_docker.sh"), "--detach"],
      {
        cwd: root,
        env: {
          ...environment,
          SUNABOT_WORKSPACE: workspace,
          SUNABOT_WORKSPACE_ID: identity,
          SUNABOT_DOCKER_NETWORK: network,
        },
        maxBuffer: PROCESS_OUTPUT_BYTES,
        timeout: 10 * 60_000,
      },
    );
  } catch (error) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_START_FAILED",
      "语音服务启动失败，请检查运行日志。",
      503,
      commandError(error),
    );
  }
  const started = await inspectVoiceContainer(run, container);
  assertContainerOwnership(started, identity);
  if (started?.State?.Running !== true) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_START_FAILED",
      "语音服务启动失败，请检查运行日志。",
    );
  }
  return runtimeStatus(started, "语音服务已启动，模型载入后即可使用。");
}

export async function detachVoiceServiceRuntimeNetwork(options = {}) {
  const { identity, container, network, run } = voiceServiceHostContext(options);
  await requireDocker(run);
  const current = await inspectVoiceContainer(run, container);
  assertContainerOwnership(current, identity);
  if (!current || !containerUsesNetwork(current, network)) return false;
  try {
    await runDocker(run, ["network", "disconnect", network, container]);
  } catch (error) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_NETWORK_DETACH_FAILED",
      "语音服务未能释放 Sunabot 运行网络。",
      503,
      commandError(error),
    );
  }
  const detached = await inspectVoiceContainer(run, container);
  assertContainerOwnership(detached, identity);
  if (containerUsesNetwork(detached, network)) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_NETWORK_DETACH_FAILED",
      "语音服务未能释放 Sunabot 运行网络。",
    );
  }
  return true;
}

export async function attachVoiceServiceRuntimeNetwork(options = {}) {
  const { identity, container, network, run } = voiceServiceHostContext(options);
  await requireDocker(run);
  const current = await inspectVoiceContainer(run, container);
  assertContainerOwnership(current, identity);
  if (!current || current.State?.Running !== true) return false;
  if (containerUsesNetwork(current, network)) return false;
  await requireDockerObject(
    run,
    ["network", "inspect", network],
    "VOICE_SERVICE_NETWORK_UNAVAILABLE",
    "语音服务运行网络不可用，请重启 Sunabot。",
  );
  try {
    await runDocker(run, [
      "network",
      "connect",
      "--alias",
      "sunabot-moss-tts-nano",
      network,
      container,
    ]);
  } catch (error) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_NETWORK_ATTACH_FAILED",
      "语音服务未能接入 Sunabot 运行网络。",
      503,
      commandError(error),
    );
  }
  const attached = await inspectVoiceContainer(run, container);
  assertContainerOwnership(attached, identity);
  if (!containerUsesNetwork(attached, network)) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_NETWORK_ATTACH_FAILED",
      "语音服务未能接入 Sunabot 运行网络。",
    );
  }
  return true;
}

function voiceServiceHostContext(options) {
  const environment = options.environment ?? process.env;
  const workspace = path.resolve(
    options.workspace ?? resolveWorkspace(root, { requireExplicit: true }),
  );
  const identity = workspaceIdentity(workspace);
  return {
    environment,
    workspace,
    identity,
    container: textSetting(
      environment.SUNABOT_MOSS_TTS_NANO_CONTAINER,
      "sunabot-moss-tts-nano",
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,
      "VOICE_SERVICE_CONTAINER_INVALID",
    ),
    network: textSetting(
      environment.SUNABOT_DOCKER_NETWORK,
      `sunabot-${identity.slice(0, 12)}-runtime`,
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,
      "VOICE_SERVICE_NETWORK_INVALID",
    ),
    run: options.execFile ?? execFileAsync,
  };
}

async function requireDocker(run) {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      maxBuffer: PROCESS_OUTPUT_BYTES,
      timeout: 15_000,
    });
  } catch (error) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_DOCKER_UNAVAILABLE",
      "Docker 服务不可用。",
      503,
      commandError(error),
    );
  }
}

async function inspectVoiceContainer(run, container) {
  try {
    const result = await run(
      "docker",
      ["container", "inspect", "--format", "{{json .}}", container],
      { maxBuffer: PROCESS_OUTPUT_BYTES, timeout: 15_000 },
    );
    return JSON.parse(String(result.stdout).trim());
  } catch (error) {
    if (numberField(error, "code") === 1) return null;
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_INSPECT_FAILED",
      "语音服务状态检查失败。",
      503,
      commandError(error),
    );
  }
}

function assertContainerOwnership(container, identity) {
  if (!container) return;
  const labels = container.Config?.Labels ?? {};
  if (
    labels[COMPONENT_LABEL] !== "voice" ||
    labels[WORKSPACE_LABEL] !== identity
  ) {
    throw new VoiceServiceHostError(
      "VOICE_SERVICE_CONTAINER_CONFLICT",
      "语音服务容器名称已被其他实例占用。",
      409,
    );
  }
}

async function requireDockerObject(run, args, code, message) {
  try {
    await runDocker(run, args);
  } catch (error) {
    throw new VoiceServiceHostError(code, message, 503, commandError(error));
  }
}

function runDocker(run, args) {
  return run("docker", args, {
    maxBuffer: PROCESS_OUTPUT_BYTES,
    timeout: 30_000,
  });
}

async function removeVoiceContainer(run, container) {
  try {
    await runDocker(run, ["rm", container]);
  } catch (error) {
    if (
      numberField(error, "code") !== 1 ||
      !/No such container:/u.test(String(error?.stderr ?? ""))
    ) {
      throw error;
    }
  }
}

function runtimeStatus(container, message) {
  return {
    state: container?.State?.Running === true ? "running" : "stopped",
    ...(message ? { message } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function containerUsesNetwork(container, network) {
  return Boolean(container?.NetworkSettings?.Networks?.[network]);
}

function textSetting(value, fallback, pattern, code) {
  const normalized = String(value ?? fallback).trim();
  if (!pattern.test(normalized)) {
    throw new VoiceServiceHostError(code, "语音服务运行配置无效。", 503);
  }
  return normalized;
}

function numberField(value, key) {
  return value && typeof value === "object" ? Number(value[key]) : NaN;
}

function commandError(error) {
  if (!error || typeof error !== "object") return String(error);
  return String(error.stderr || error.stdout || error.message || "").slice(0, 2_000);
}

async function main() {
  const action = process.argv[2];
  try {
    const service = await controlVoiceService(action);
    process.stdout.write(`SUNABOT_VOICE_SERVICE=${JSON.stringify(service)}\n`);
  } catch (error) {
    const normalized =
      error instanceof VoiceServiceHostError
        ? error
        : new VoiceServiceHostError(
            "VOICE_SERVICE_CONTROL_FAILED",
            "语音服务操作失败，请检查运行日志。",
            503,
            String(error),
          );
    if (normalized.internalMessage) {
      process.stderr.write(`[voice-service] ${normalized.internalMessage}\n`);
    }
    process.stderr.write(
      `SUNABOT_VOICE_SERVICE_ERROR=${JSON.stringify({
        code: normalized.code,
        message: normalized.message,
        status: normalized.status,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
