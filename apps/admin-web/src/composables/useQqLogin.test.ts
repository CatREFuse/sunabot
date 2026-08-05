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

  it("automatically replaces an expired QR image", async () => {
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

    expect(control.snapshot.value?.phase).toBe("waiting_scan");
    expect(control.snapshot.value?.imageDataUrl).toBe("data:image/png;base64,FRESH");
    expect(apiRequest).toHaveBeenCalledWith("/api/onebot/qq-login", expect.objectContaining({ method: "POST" }));
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
    imageUpdatedAt
  };
}
