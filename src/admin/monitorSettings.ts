import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

export interface MonitorRuntimeSettings {
  barkUrl: string;
  aggregationWindowMs: number;
  onebotOfflineGraceMs: number;
  heartbeatStaleMs: number;
  serverEventsEnabled: boolean;
  onebotEventsEnabled: boolean;
}

export interface MonitorSettingsUpdate {
  barkUrl?: string;
  clearBarkUrl?: boolean;
  aggregationWindowSeconds?: number;
  onebotOfflineGraceSeconds?: number;
  heartbeatStaleSeconds?: number;
  serverEventsEnabled?: boolean;
  onebotEventsEnabled?: boolean;
}

export class MonitorSettingsStore {
  constructor(private readonly envPath: string) {}

  async publicSettings() {
    const settings = await this.runtimeSettings();
    return {
      barkConfigured: Boolean(settings.barkUrl),
      aggregationWindowSeconds: settings.aggregationWindowMs / 1_000,
      onebotOfflineGraceSeconds: settings.onebotOfflineGraceMs / 1_000,
      heartbeatStaleSeconds: settings.heartbeatStaleMs / 1_000,
      serverEventsEnabled: settings.serverEventsEnabled,
      onebotEventsEnabled: settings.onebotEventsEnabled
    };
  }

  async runtimeSettings(): Promise<MonitorRuntimeSettings> {
    const env = await this.read();
    return {
      barkUrl: env.BARK_URL?.trim() ?? "",
      aggregationWindowMs: seconds(env.SUNABOT_BARK_AGGREGATION_SECONDS, 60, 5, 600) * 1_000,
      onebotOfflineGraceMs: seconds(env.SUNABOT_ONEBOT_OFFLINE_GRACE_SECONDS, 20, 0, 600) * 1_000,
      heartbeatStaleMs: seconds(env.SUNABOT_ONEBOT_HEARTBEAT_STALE_SECONDS, 120, 30, 3_600) * 1_000,
      serverEventsEnabled: booleanEnv(env.SUNABOT_MONITOR_SERVER_EVENTS, true),
      onebotEventsEnabled: booleanEnv(env.SUNABOT_MONITOR_ONEBOT_EVENTS, true)
    };
  }

  async update(input: MonitorSettingsUpdate) {
    const env = await this.read();
    if (input.clearBarkUrl) delete env.BARK_URL;
    if (typeof input.barkUrl === "string" && input.barkUrl.trim()) {
      const url = new URL(input.barkUrl.trim());
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
        throw new Error("Bark URL 必须使用 HTTPS；仅回环地址允许 HTTP。");
      }
      if (url.username || url.password) throw new Error("Bark URL 不得包含 URL 用户名或密码。");
      env.BARK_URL = url.toString().replace(/\/+$/, "");
    }
    assignNumber(env, "SUNABOT_BARK_AGGREGATION_SECONDS", input.aggregationWindowSeconds, 5, 600);
    assignNumber(env, "SUNABOT_ONEBOT_OFFLINE_GRACE_SECONDS", input.onebotOfflineGraceSeconds, 0, 600);
    assignNumber(env, "SUNABOT_ONEBOT_HEARTBEAT_STALE_SECONDS", input.heartbeatStaleSeconds, 30, 3_600);
    assignBoolean(env, "SUNABOT_MONITOR_SERVER_EVENTS", input.serverEventsEnabled);
    assignBoolean(env, "SUNABOT_MONITOR_ONEBOT_EVENTS", input.onebotEventsEnabled);
    await this.write(env);
    return this.publicSettings();
  }

  private async read() {
    try {
      return dotenv.parse(await fs.readFile(this.envPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(env: Record<string, string>) {
    await fs.mkdir(path.dirname(this.envPath), { recursive: true, mode: 0o700 });
    const lines = Object.entries(env).map(([key, value]) => `${key}=${encodeEnv(value)}`);
    const temporary = `${this.envPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.envPath);
    await fs.chmod(this.envPath, 0o600).catch(() => undefined);
  }
}

function seconds(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean) {
  if (value == null) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function assignNumber(env: Record<string, string>, key: string, value: number | undefined, min: number, max: number) {
  if (value == null) return;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 超出允许范围。`);
  env[key] = String(value);
}

function assignBoolean(env: Record<string, string>, key: string, value: boolean | undefined) {
  if (value != null) env[key] = value ? "true" : "false";
}

function encodeEnv(value: string) {
  return /[\s#'"\\]/.test(value) ? JSON.stringify(value) : value;
}

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}
