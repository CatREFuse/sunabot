import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceDir } from "../../src/config.js";

export type VoiceServiceAction = "check" | "start" | "stop";
export type VoiceServiceRuntimeState = "running" | "stopped" | "unknown";

export interface VoiceServiceRuntimeStatus {
  state: VoiceServiceRuntimeState;
  message?: string;
  updatedAt: string;
}

export interface VoiceServiceControlPort {
  check(): Promise<VoiceServiceRuntimeStatus>;
  start(): Promise<VoiceServiceRuntimeStatus>;
  stop(): Promise<VoiceServiceRuntimeStatus>;
}

export class VoiceServiceControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "VoiceServiceControlError";
  }
}

export class VoiceServiceControlClient implements VoiceServiceControlPort {
  constructor(
    private readonly options: {
      workspace?: string;
      pollIntervalMs?: number;
      timeoutMs?: number;
    } = {},
  ) {}

  check() {
    return this.request("check");
  }

  start() {
    return this.request("start");
  }

  stop() {
    return this.request("stop");
  }

  private async request(action: VoiceServiceAction) {
    const workspace = this.options.workspace ?? getWorkspaceDir();
    if (!(await hostRuntimeControlConfigured(workspace))) {
      throw new VoiceServiceControlError(
        "VOICE_SERVICE_CONTROL_UNAVAILABLE",
        "语音服务管理不可用，请重启 Sunabot。",
      );
    }
    const requestId = crypto.randomUUID();
    const root = path.join(workspace, "runtime/account-reconciler");
    const requestPath = path.join(root, "requests", `${requestId}.json`);
    const resultPath = path.join(root, "results", `${requestId}.json`);
    await atomicJson(requestPath, {
      schemaVersion: 1,
      kind: "voice-service-control",
      requestId,
      action,
      requestedAt: new Date().toISOString(),
    });
    const timeoutMs =
      this.options.timeoutMs ?? (action === "start" ? 10 * 60_000 : 30_000);
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        try {
          const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as {
            schemaVersion?: number;
            kind?: string;
            requestId?: string;
            service?: VoiceServiceRuntimeStatus;
            error?: { code?: unknown; message?: unknown; status?: unknown };
          };
          if (
            result.schemaVersion !== 1 ||
            result.kind !== "voice-service-control" ||
            result.requestId !== requestId
          ) {
            throw new VoiceServiceControlError(
              "VOICE_SERVICE_CONTROL_INVALID",
              "语音服务管理返回了无效结果。",
            );
          }
          if (result.error) {
            throw new VoiceServiceControlError(
              safeCode(result.error.code),
              safeMessage(result.error.message),
              safeStatus(result.error.status),
            );
          }
          return validateStatus(result.service);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(this.options.pollIntervalMs ?? 100);
      }
      throw new VoiceServiceControlError(
        "VOICE_SERVICE_CONTROL_TIMEOUT",
        "语音服务操作超时，请重新检测。",
      );
    } finally {
      await Promise.all([
        fs.rm(requestPath, { force: true }),
        fs.rm(resultPath, { force: true }),
      ]);
    }
  }
}

function validateStatus(value: VoiceServiceRuntimeStatus | undefined) {
  if (
    !value ||
    !["running", "stopped", "unknown"].includes(value.state) ||
    typeof value.updatedAt !== "string" ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    throw new VoiceServiceControlError(
      "VOICE_SERVICE_CONTROL_INVALID",
      "语音服务管理返回了无效结果。",
    );
  }
  return value;
}

async function atomicJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporary, filePath);
}

async function hostRuntimeControlConfigured(workspace: string) {
  try {
    const state = JSON.parse(
      await fs.readFile(
        path.join(workspace, "runtime/launcher-state.json"),
        "utf8",
      ),
    );
    return (
      Number.isSafeInteger(state?.reconciler?.pid) && state.reconciler.pid > 0
    );
  } catch {
    return false;
  }
}

function safeCode(value: unknown) {
  return typeof value === "string" && /^VOICE_SERVICE_[A-Z0-9_]+$/u.test(value)
    ? value
    : "VOICE_SERVICE_CONTROL_FAILED";
}

function safeMessage(value: unknown) {
  return typeof value === "string" && value.length <= 300
    ? value
    : "语音服务操作失败，请检查运行日志。";
}

function safeStatus(value: unknown) {
  return value === 409 ? 409 : 503;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
