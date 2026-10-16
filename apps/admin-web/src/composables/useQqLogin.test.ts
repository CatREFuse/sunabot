import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneBotQrLogin } from "../types";
import { useQqLogin } from "./useQqLogin";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

let wrapper: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  apiRequest.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

describe("useQqLogin", () => {
  it("still requests a refresh when the opening status read fails", async () => {
    apiRequest.mockRejectedValueOnce(new Error("状态读取失败"))
      .mockResolvedValueOnce(qrSnapshot(new Date().toISOString(), "FRESH"));
    const control = mountControl();
    await control.openDialog();
    expect(apiRequest).toHaveBeenLastCalledWith("/api/onebot/qq-login", expect.objectContaining({ method: "POST" }));
    expect(control.qrBlocked.value).toBe(false);
  });

  it("hides the opening status image until refresh completes and refreshes on reopen", async () => {
    let resolveRefresh!: (value: OneBotQrLogin) => void;
    apiRequest.mockResolvedValueOnce(qrSnapshot(new Date().toISOString(), "OLD"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    const control = mountControl();
    const opening = control.openDialog();
    await flushPromises();
    expect(control.snapshot.value?.imageDataUrl).toBeUndefined();
    expect(control.qrBlocked.value).toBe(true);
    resolveRefresh(qrSnapshot(new Date().toISOString(), "NEW"));
    await opening;
    expect(control.qrBlocked.value).toBe(false);
    control.closeDialog();
    apiRequest.mockResolvedValue(qrSnapshot(new Date().toISOString(), "NEWER"));
    await control.openDialog();
    expect(apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("expires by absolute deadline after tab suspension and polling cannot remove the mask", async () => {
    const qr = qrSnapshot(new Date().toISOString(), "FIRST");
    apiRequest.mockResolvedValue(qr);
    const control = mountControl();
    await control.openDialog();
    expect(control.remainingSeconds.value).toBe(60);
    vi.setSystemTime(Date.now() + 61_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(control.qrBlocked.value).toBe(true);
    expect(control.remainingSeconds.value).toBe(0);
    apiRequest.mockResolvedValue(qrSnapshot(new Date().toISOString(), "AUTO"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(control.qrBlocked.value).toBe(true);
    expect(apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await control.refreshQrCode();
    expect(control.qrBlocked.value).toBe(false);
  });

  it("keeps failed refresh masked even if polling returns an image", async () => {
    apiRequest.mockResolvedValue(qrSnapshot(new Date().toISOString(), "OLD"));
    const control = mountControl();
    await control.openDialog();
    apiRequest.mockRejectedValueOnce(new Error("NapCat 未生成新二维码"));
    await control.refreshQrCode();
    expect(control.qrBlocked.value).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(control.qrBlocked.value).toBe(true);
    expect(control.error.value).toContain("未生成");
  });

  it("does not extend an expired display window when a delayed poll supplies another QR", async () => {
    apiRequest.mockResolvedValue(qrSnapshot(new Date().toISOString(), "OLD"));
    const control = mountControl();
    await control.openDialog();
    let release!: (value: OneBotQrLogin) => void;
    apiRequest.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(2_000);
    vi.setSystemTime(Date.now() + 61_000);
    release(qrSnapshot(new Date().toISOString(), "AUTO"));
    await flushPromises();
    expect(control.qrBlocked.value).toBe(true);
  });

  it("ignores a status response started before manual refresh", async () => {
    apiRequest.mockResolvedValue(qrSnapshot(new Date().toISOString(), "OLD"));
    const control = mountControl();
    await control.openDialog();
    let release!: (value: OneBotQrLogin) => void;
    apiRequest.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(2_000);
    apiRequest.mockResolvedValue(qrSnapshot(new Date().toISOString(), "NEW"));
    await control.refreshQrCode();
    release({ ...qrSnapshot(new Date().toISOString(), "OLD"), phase: "expired" });
    await flushPromises();
    expect(control.snapshot.value?.imageDataUrl).toContain("NEW");
    expect(control.qrBlocked.value).toBe(false);
  });

  it("offers explicit recovery if a retained session becomes invalid during polling", async () => {
    apiRequest.mockResolvedValueOnce({ connected: true, online: false, authenticated: true, available: true, phase: "reconnecting" })
      .mockResolvedValueOnce({ connected: true, online: false, authenticated: false, available: true, phase: "restarting", action: "recover_login" })
      .mockResolvedValueOnce(qrSnapshot("2026-10-14T00:00:00.000Z", "RECOVERED"));
    const control = mountControl();
    await control.openDialog();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(control.snapshot.value?.action).toBe("recover_login");
    expect(apiRequest.mock.calls.every(([route]) => route.endsWith("/status"))).toBe(true);
    await control.refreshQrCode();
    expect(apiRequest).toHaveBeenLastCalledWith("/api/onebot/qq-login", expect.objectContaining({ method: "POST" }));
    expect(control.snapshot.value?.phase).toBe("waiting_scan");
  });

  it("waits for an authenticated offline session to recover without requesting a new login", async () => {
    apiRequest.mockResolvedValueOnce({ connected: true, online: false, authenticated: true, available: true, phase: "reconnecting" })
      .mockResolvedValueOnce({ connected: true, online: true, authenticated: true, available: true, phase: "online" });
    const control = mountControl();
    await control.openDialog();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(control.snapshot.value?.phase).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(control.online.value).toBe(true);
    expect(apiRequest.mock.calls.every(([route]) => route.endsWith("/status"))).toBe(true);
  });

  it("refreshes once on open and pulls replacement QR images while polling", async () => {
    let statusReads = 0;
    apiRequest.mockImplementation((route: string, init?: RequestInit) => {
      if (route === "/api/onebot/qq-login" && init?.method === "POST") {
        return Promise.resolve(qrSnapshot("2026-07-12T00:00:01.000Z", "AAAA"));
      }
      if (route === "/api/onebot/qq-login/status") {
        statusReads += 1;
        return Promise.resolve(statusReads === 1
          ? { connected: false, online: false, available: true, phase: "starting" }
          : qrSnapshot("2026-07-12T00:00:03.000Z", "BBBB"));
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    const control = mountControl();

    await control.openDialog();
    expect(control.snapshot.value?.imageDataUrl).toBe("data:image/png;base64,AAAA");
    expect(apiRequest).toHaveBeenCalledWith("/api/onebot/qq-login", expect.objectContaining({ method: "POST" }));

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(control.snapshot.value?.imageDataUrl).toBe("data:image/png;base64,BBBB");
    expect(control.snapshot.value?.imageUpdatedAt).toBe("2026-07-12T00:00:03.000Z");
  });

  it("moves from online through logout restart to a scannable QR", async () => {
    apiRequest.mockImplementation((route: string, init?: RequestInit) => {
      if (route === "/api/onebot/qq-login/status") {
        if (!init && apiRequest.mock.calls.filter(([value]) => value === route).length === 1) {
          return Promise.resolve({ connected: true, online: true, available: true, phase: "online", data: { user_id: 985436737 } });
        }
        return Promise.resolve(qrSnapshot("2026-07-12T00:00:05.000Z", "CCCC"));
      }
      if (route === "/api/onebot/qq-logout") {
        return Promise.resolve({ connected: false, online: false, available: true, phase: "restarting" });
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    const control = mountControl();

    await control.openDialog();
    expect(control.online.value).toBe(true);
    control.requestLogout();
    expect(control.confirmingLogout.value).toBe(true);
    await control.logout();
    expect(control.snapshot.value?.phase).toBe("restarting");

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(control.snapshot.value?.phase).toBe("waiting_scan");
    expect(control.snapshot.value?.imageDataUrl).toBe("data:image/png;base64,CCCC");
  });

  it("automatically recovers a kicked account and shows its replacement QR", async () => {
    apiRequest.mockImplementation((route: string, init?: RequestInit) => {
      if (route === "/api/onebot/qq-login/status") {
        return Promise.resolve({
          connected: true,
          online: false,
          available: true,
          phase: "restarting",
          action: "recover_login"
        });
      }
      if (route === "/api/onebot/qq-login" && init?.method === "POST") {
        return Promise.resolve(qrSnapshot("2026-08-05T00:00:01.000Z", "RECOVERED"));
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    const control = mountControl();

    await control.openDialog();

    expect(apiRequest).toHaveBeenCalledWith("/api/onebot/qq-login", expect.objectContaining({ method: "POST" }));
    expect(control.snapshot.value?.phase).toBe("waiting_scan");
    expect(control.snapshot.value?.imageDataUrl).toBe("data:image/png;base64,RECOVERED");
  });

  it("blocks expired QR images until an explicit refresh", async () => {
    let statusReads = 0;
    apiRequest.mockImplementation((route: string, init?: RequestInit) => {
      if (route === "/api/onebot/qq-login/status") {
        statusReads += 1;
        return Promise.resolve(statusReads === 1
          ? qrSnapshot("2026-07-12T00:00:01.000Z", "AAAA")
          : { ...qrSnapshot("2026-07-12T00:01:01.000Z", "EXPIRED"), phase: "expired" });
      }
      if (route === "/api/onebot/qq-login" && init?.method === "POST") {
        return Promise.resolve(qrSnapshot("2026-07-12T00:01:02.000Z", "FRESH"));
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    const control = mountControl();

    await control.openDialog();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    expect(control.qrBlocked.value).toBe(true);
    expect(apiRequest.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await control.refreshQrCode();
    expect(control.qrBlocked.value).toBe(false);
    expect(control.snapshot.value?.imageDataUrl).toBe("data:image/png;base64,FRESH");
  });

  it("freezes status, login, and logout routes to the account that opened the dialog", async () => {
    let selectedAccountId = "secondary";
    let releaseStatus!: (snapshot: OneBotQrLogin) => void;
    const status = new Promise<OneBotQrLogin>((resolve) => {
      releaseStatus = resolve;
    });
    apiRequest.mockImplementation((route: string, init?: RequestInit) => {
      if (route === "/api/accounts/secondary/status") return status;
      if (route === "/api/accounts/secondary/login" && init?.method === "POST") {
        return Promise.resolve({ connected: true, online: true, available: true, phase: "online", data: { user_id: 42 } });
      }
      if (route === "/api/accounts/secondary/logout" && init?.method === "POST") {
        return Promise.resolve({ connected: false, online: false, available: true, phase: "restarting" });
      }
      throw new Error(`Unexpected request: ${route}`);
    });
    const control = mountControl({
      paths: () => ({
        status: `/api/accounts/${selectedAccountId}/status`,
        login: `/api/accounts/${selectedAccountId}/login`,
        logout: `/api/accounts/${selectedAccountId}/logout`
      })
    });

    const opening = control.openDialog();
    selectedAccountId = "primary";
    releaseStatus({ connected: false, online: false, available: true, phase: "starting" });
    await opening;
    expect(control.online.value).toBe(true);

    control.requestLogout();
    await control.logout();

    expect(apiRequest).toHaveBeenCalledWith("/api/accounts/secondary/status");
    expect(apiRequest).toHaveBeenCalledWith("/api/accounts/secondary/login", expect.objectContaining({ method: "POST" }));
    expect(apiRequest).toHaveBeenCalledWith("/api/accounts/secondary/logout", expect.objectContaining({ method: "POST" }));
    expect(apiRequest.mock.calls.some(([route]) => String(route).includes("/primary/"))).toBe(false);
  });
});

function mountControl(options: Parameters<typeof useQqLogin>[0] = {}) {
  let control!: ReturnType<typeof useQqLogin>;
  const Harness = defineComponent({
    setup() {
      control = useQqLogin(options);
      return () => h("div");
    }
  });
  wrapper = mount(Harness);
  return control;
}

function qrSnapshot(imageUpdatedAt: string, base64: string): OneBotQrLogin {
  return {
    connected: false,
    online: false,
    available: true,
    phase: "waiting_scan",
    imageDataUrl: `data:image/png;base64,${base64}`,
    imageUpdatedAt,
    imageExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
}
