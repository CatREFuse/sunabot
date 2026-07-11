import { MonitorSettingsStore } from "./admin/monitorSettings.js";
import { getWorkspacePath } from "./config.js";
import { OneBotGateway } from "../adapters/onebot/onebotGateway.js";
import { SunaRuntime } from "./runtime.js";
import { WORKSPACE_LAYOUT } from "../packages/platform/workspaceLayout.js";

const MONITOR_INTERVAL_MS = 30_000;
const ONLINE_ANNOUNCE_COOLDOWN_MS = 5 * 60 * 1000;
const ONLINE_MESSAGE = "服务已恢复，OneBot 已连接。";

type MonitorChannel = "onebot" | "server";

interface PendingNotification {
  messages: Set<string>;
  timer?: NodeJS.Timeout;
}

export class ServiceMonitor {
  private timer?: NodeJS.Timeout;
  private disconnectTimer?: NodeJS.Timeout;
  private readonly pending = new Map<MonitorChannel, PendingNotification>();
  private onebotStale = false;
  private onebotOfflineNotified = false;
  private lastOnlineAnnouncementAt = 0;
  private started = false;

  constructor(
    private readonly runtime: SunaRuntime,
    private readonly gateway: OneBotGateway,
    private readonly settings = new MonitorSettingsStore(getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv))
  ) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.gateway.on("connected", this.onConnected);
    this.gateway.on("disconnected", this.onDisconnected);
    this.gateway.on("error", this.onGatewayError);
    process.on("unhandledRejection", this.onUnhandledRejection);
    process.on("uncaughtException", this.onUncaughtException);
    process.once("SIGINT", this.onSigint);
    process.once("SIGTERM", this.onSigterm);

    this.timer = setInterval(() => void this.checkOneBotState(), MONITOR_INTERVAL_MS);
    this.timer.unref();
    void this.enqueue("server", "服务已启动。");
    void this.checkOneBotState();
  }

  close() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    for (const item of this.pending.values()) if (item.timer) clearTimeout(item.timer);
    this.pending.clear();
    this.gateway.off("connected", this.onConnected);
    this.gateway.off("disconnected", this.onDisconnected);
    this.gateway.off("error", this.onGatewayError);
    process.off("unhandledRejection", this.onUnhandledRejection);
    process.off("uncaughtException", this.onUncaughtException);
    process.off("SIGINT", this.onSigint);
    process.off("SIGTERM", this.onSigterm);
  }

  private readonly onConnected = () => {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    void this.handleOneBotOnline("反向 WebSocket 已连接。");
  };

  private readonly onDisconnected = () => {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    void this.settings.runtimeSettings().then((settings) => {
      this.disconnectTimer = setTimeout(() => {
        if (this.gateway.getStatus().connected || this.onebotOfflineNotified) return;
        this.onebotOfflineNotified = true;
        void this.enqueue("onebot", "OneBot 反向 WebSocket 已断开。");
      }, settings.onebotOfflineGraceMs);
      this.disconnectTimer.unref();
    });
  };

  private readonly onGatewayError = (error: unknown) => {
    void this.enqueue("onebot", `OneBot 连接异常：${errorMessage(error)}`);
  };

  private readonly onUnhandledRejection = (reason: unknown) => {
    void this.enqueue("server", `Unhandled rejection：${errorMessage(reason)}`);
  };

  private readonly onUncaughtException = (error: Error) => {
    void this.enqueue("server", `Uncaught exception：${errorMessage(error)}`, true).finally(() => process.exit(1));
  };

  private readonly onSigint = () => void this.handleShutdownSignal("SIGINT");
  private readonly onSigterm = () => void this.handleShutdownSignal("SIGTERM");

  private async checkOneBotState() {
    const status = this.gateway.getStatus();
    if (!status.connected) return;
    const settings = await this.settings.runtimeSettings();
    const lastEventAt = status.lastEventAt ? Date.parse(status.lastEventAt) : Date.parse(status.connectedAt ?? "");
    const stale = !Number.isFinite(lastEventAt) || Date.now() - lastEventAt > settings.heartbeatStaleMs;
    if (stale && !this.onebotStale) {
      this.onebotStale = true;
      await this.enqueue("onebot", "OneBot 已连接，但事件心跳超时。");
    } else if (!stale && this.onebotStale) {
      this.onebotStale = false;
      await this.handleOneBotOnline("事件心跳已恢复。");
    }
  }

  private async handleOneBotOnline(reason: string) {
    const wasOffline = this.onebotOfflineNotified || this.onebotStale;
    this.onebotOfflineNotified = false;
    this.onebotStale = false;
    if (wasOffline) await this.enqueue("onebot", `OneBot 已恢复：${reason}`);

    if (isTruthyEnvironmentValue(process.env.SUNABOT_SUPPRESS_QQ_ONLINE_ANNOUNCEMENT)) return;
    const now = Date.now();
    if (now - this.lastOnlineAnnouncementAt < ONLINE_ANNOUNCE_COOLDOWN_MS) return;
    this.lastOnlineAnnouncementAt = now;
    await this.runtime.announceServiceOnline(this.gateway, ONLINE_MESSAGE);
  }

  private async handleShutdownSignal(signal: NodeJS.Signals) {
    if (this.timer) clearInterval(this.timer);
    await this.enqueue("server", `服务收到 ${signal}，正在停止。`, true);
    process.exit(0);
  }

  private async enqueue(channel: MonitorChannel, message: string, flushNow = false, force = false) {
    const settings = await this.settings.runtimeSettings();
    if (!settings.barkUrl) return;
    if (!force && channel === "onebot" && !settings.onebotEventsEnabled) return;
    if (!force && channel === "server" && !settings.serverEventsEnabled) return;
    const item = this.pending.get(channel) ?? { messages: new Set<string>() };
    item.messages.add(sanitizeMessage(message));
    this.pending.set(channel, item);
    if (flushNow) return this.flush(channel);
    if (item.timer) return;
    item.timer = setTimeout(() => void this.flush(channel), settings.aggregationWindowMs);
    item.timer.unref();
  }

  async testNotification() {
    const settings = await this.settings.runtimeSettings();
    if (!settings.barkUrl) throw new Error("Bark URL 尚未配置。");
    await this.enqueue("server", "Bark 通知测试成功。", true, true);
    return { ok: true };
  }

  private async flush(channel: MonitorChannel) {
    const item = this.pending.get(channel);
    if (!item?.messages.size) return;
    if (item.timer) clearTimeout(item.timer);
    this.pending.delete(channel);
    const settings = await this.settings.runtimeSettings();
    if (!settings.barkUrl) return;
    const body = [...item.messages].join("\n");
    try {
      const title = channel === "onebot" ? "Sunabot · OneBot" : "Sunabot · Server";
      const url = new URL(`${settings.barkUrl}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
      url.searchParams.set("group", `sunabot-${channel}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) console.error("[monitor] bark notification failed", { channel, status: response.status });
    } catch (error) {
      console.error("[monitor] bark notification failed", errorMessage(error));
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error || "未知错误");
}

function sanitizeMessage(message: string) {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|access[_-]?token|authorization)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 500)
    .trim() || "未知错误";
}

function isTruthyEnvironmentValue(value: string | undefined) {
  return value != null && /^(?:1|true|yes|on)$/i.test(value.trim());
}
