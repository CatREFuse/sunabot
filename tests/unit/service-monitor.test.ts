// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceMonitor } from "../../src/serviceMonitor.js";

const originalSuppressValue = process.env.SUNABOT_SUPPRESS_QQ_ONLINE_ANNOUNCEMENT;

afterEach(() => {
  vi.useRealTimers();
  if (originalSuppressValue === undefined) delete process.env.SUNABOT_SUPPRESS_QQ_ONLINE_ANNOUNCEMENT;
  else process.env.SUNABOT_SUPPRESS_QQ_ONLINE_ANNOUNCEMENT = originalSuppressValue;
  vi.unstubAllGlobals();
});

function fixture(overrides: Record<string, unknown> = {}) {
  const gateway = new EventEmitter() as EventEmitter & { getStatus(): Record<string, unknown> };
  let status: Record<string, unknown> = { connected: false };
  gateway.getStatus = () => status;
  const announceServiceOnline = vi.fn(async () => ({ sent: 0, total: 0 }));
  const settings = {
    runtimeSettings: vi.fn(async () => ({
      barkUrl: "https://bark.example.test/test-device-key",
      aggregationWindowMs: 50,
      onebotOfflineGraceMs: 20,
      heartbeatStaleMs: 120_000,
      serverEventsEnabled: false,
      onebotEventsEnabled: true,
      ...overrides
    }))
  };
  const monitor = new ServiceMonitor({ announceServiceOnline } as never, gateway as never, settings as never);
  return { monitor, gateway, announceServiceOnline, setStatus: (next: Record<string, unknown>) => { status = next; } };
}

describe("ServiceMonitor", () => {
  it("detects one account's stale heartbeat while another account keeps receiving events", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { monitor, setStatus } = fixture();
    const old = new Date(Date.now() - 180_000).toISOString();
    const now = new Date().toISOString();
    setStatus({ connected: true, lastEventAt: now, accounts: [
      { accountId: "arona", connectedAt: old, lastEventAt: old },
      { accountId: "plana", connectedAt: old, lastEventAt: now }
    ] });
    monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain("arona 已连接，但事件心跳超时");
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).not.toContain("plana");
    monitor.close();
  });

  it("reports an individual account disconnect and recovery while another stays connected", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { monitor, gateway, setStatus } = fixture();
    setStatus({ connected: true, accounts: [{ accountId: "plana", connectedAt: new Date().toISOString() }] });
    monitor.start();
    gateway.emit("accountDisconnected", { accountId: "arona" });
    await vi.advanceTimersByTimeAsync(75);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain("arona 反向 WebSocket 已断开");
    gateway.emit("accountConnected", { accountId: "arona" });
    await vi.advanceTimersByTimeAsync(50);
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))).toContain("arona 已恢复连接");
    monitor.close();
  });

  it("can suppress QQ-wide online announcements for a controlled restart", async () => {
    process.env.SUNABOT_SUPPRESS_QQ_ONLINE_ANNOUNCEMENT = "1";
    const { monitor, announceServiceOnline } = fixture();
    await (monitor as unknown as { handleOneBotOnline(reason: string): Promise<void> }).handleOneBotOnline("connected");
    expect(announceServiceOnline).not.toHaveBeenCalled();
  });

  it("reports a sustained OneBot disconnect and does not use server-event detection", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { monitor, gateway } = fixture();
    monitor.start();
    gateway.emit("disconnected");
    await vi.advanceTimersByTimeAsync(75);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(decodeURIComponent(requestUrl)).toContain("OneBot 反向 WebSocket 已断开");
    expect(requestUrl).toContain("group=sunabot-onebot");
    monitor.close();
  });

  it("aggregates repeated messages into one Bark request per channel window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { monitor } = fixture();
    const enqueue = (monitor as unknown as { enqueue(channel: "onebot", message: string): Promise<void> }).enqueue.bind(monitor);
    await enqueue("onebot", "event A");
    await enqueue("onebot", "event A");
    await enqueue("onebot", "event B");
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const decoded = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]));
    expect(decoded).toContain("event A\nevent B");
  });

  it("flushes the shutdown notice without terminating the process", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { monitor } = fixture({ serverEventsEnabled: true });

    await monitor.notifyShutdown("SIGTERM");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain("正在停止");
  });
});
