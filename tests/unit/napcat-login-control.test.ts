// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NapcatLoginControl } from "../../adapters/onebot/napcatLoginControl.js";

const temporaryDirectories: string[] = [];
const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("NapcatLoginControl", () => {
  it("authenticates once and returns the newly refreshed QR image", async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const pathname = new URL(input).pathname;
      if (pathname === "/api/auth/login") return json({ code: 0, data: { Credential: "credential" } });
      if (pathname === "/api/QQLogin/CheckLoginStatus") {
        return json({ code: 0, data: { isLogin: false, qrcodeurl: "https://txz.qq.com/example", loginError: "" } });
      }
      if (pathname === "/api/QQLogin/RefreshQRcode") {
        await fs.writeFile(fixture.qrCodePath, pngHeader);
        return json({ code: 0, data: null });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const control = new NapcatLoginControl({ ...fixture, fetchImpl, requestTimeoutMs: 1_000 });

    const snapshot = await control.refreshQrCode();

    expect(snapshot).toMatchObject({
      isLogin: false,
      manualLogin: false,
      qrcodeUrl: "https://txz.qq.com/example"
    });
    expect(snapshot.imageDataUrl).toBe(`data:image/png;base64,${pngHeader.toString("base64")}`);
    expect(fetchImpl.mock.calls.filter(([input]) => new URL(input as string).pathname === "/api/auth/login"))
      .toHaveLength(1);
    control.close();
  });

  it("waits for an offline state before persisting the scanned QQ", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.runtimeEnvPath, "ONEBOT_ACCESS_TOKEN=test\nNAPCAT_ACCOUNT=123456\n", { mode: 0o600 });
    await fs.writeFile(fixture.manualLoginMarkerPath, "{}\n", { mode: 0o600 });
    await fs.writeFile(fixture.qrCodePath, pngHeader);
    let isLogin = true;
    const quickLoginAccounts: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const pathname = new URL(input).pathname;
      if (pathname === "/api/auth/login") return json({ code: 0, data: { Credential: "credential" } });
      if (pathname === "/api/QQLogin/CheckLoginStatus") return json({ code: 0, data: { isLogin } });
      if (pathname === "/api/QQLogin/GetQQLoginInfo") {
        return json({ code: 0, data: { uin: "985436737", nick: "A.R.O.N.A [试作型]", online: true } });
      }
      if (pathname === "/api/QQLogin/SetQuickLoginQQ") {
        quickLoginAccounts.push(JSON.parse(String(init?.body)).uin);
        return json({ code: 0, data: null });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const control = new NapcatLoginControl({ ...fixture, fetchImpl, requestTimeoutMs: 1_000 });

    const staleSnapshot = await control.status();

    expect(staleSnapshot).toMatchObject({ isLogin: true, manualLogin: true });
    await expect(fs.access(fixture.manualLoginMarkerPath)).resolves.toBeUndefined();
    await expect(fs.readFile(fixture.runtimeEnvPath, "utf8"))
      .resolves.toContain("NAPCAT_ACCOUNT=123456");

    isLogin = false;
    await expect(control.status()).resolves.toMatchObject({ isLogin: false, manualLogin: true });
    isLogin = true;
    const snapshot = await control.status();

    expect(snapshot).toMatchObject({
      isLogin: true,
      manualLogin: false,
      data: { user_id: 985436737, nickname: "A.R.O.N.A [试作型]" }
    });
    await expect(fs.readFile(fixture.runtimeEnvPath, "utf8"))
      .resolves.toContain("NAPCAT_ACCOUNT=985436737");
    await expect(fs.access(fixture.manualLoginMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(fixture.qrCodePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(quickLoginAccounts).toEqual(["985436737"]);
    control.close();
  });

  it("creates and cancels the marker used to suppress Docker quick login", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.runtimeEnvPath, "NAPCAT_ACCOUNT=123456\n", { mode: 0o600 });
    await fs.writeFile(fixture.qrCodePath, pngHeader);
    const quickLoginAccounts: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const pathname = new URL(input).pathname;
      if (pathname === "/api/auth/login") return json({ code: 0, data: { Credential: "credential" } });
      if (pathname === "/api/QQLogin/SetQuickLoginQQ") {
        quickLoginAccounts.push(JSON.parse(String(init?.body)).uin);
        return json({ code: 0, data: null });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const control = new NapcatLoginControl({ ...fixture, fetchImpl });

    await control.beginManualLogin();
    await expect(fs.readFile(fixture.manualLoginMarkerPath, "utf8")).resolves.toContain("requestedAt");
    await expect(fs.access(fixture.qrCodePath)).rejects.toMatchObject({ code: "ENOENT" });

    await control.cancelManualLogin();
    await expect(fs.access(fixture.manualLoginMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(quickLoginAccounts).toEqual(["", "123456"]);
    control.close();
  });

  it("uses the NapCat service address for Docker Core", async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.origin).toBe("http://napcat:6099");
      if (url.pathname === "/api/auth/login") return json({ code: 0, data: { Credential: "credential" } });
      return json({ code: 0, data: { isLogin: false } });
    });
    const control = new NapcatLoginControl({
      ...fixture,
      webuiBaseUrl: "http://napcat:6099",
      fetchImpl
    });

    await expect(control.status()).resolves.toMatchObject({ isLogin: false });
    control.close();
  });

  it("finishes a login after Core restarts when offline observation was persisted", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.manualLoginMarkerPath, JSON.stringify({
      requestedAt: "2026-07-12T00:00:00.000Z",
      offlineObservedAt: "2026-07-12T00:00:01.000Z"
    }), { mode: 0o600 });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const pathname = new URL(input).pathname;
      if (pathname === "/api/auth/login") return json({ code: 0, data: { Credential: "credential" } });
      if (pathname === "/api/QQLogin/CheckLoginStatus") return json({ code: 0, data: { isLogin: true } });
      if (pathname === "/api/QQLogin/GetQQLoginInfo") {
        return json({ code: 0, data: { uin: "985436737", nick: "A.R.O.N.A [试作型]" } });
      }
      if (pathname === "/api/QQLogin/SetQuickLoginQQ") return json({ code: 0, data: null });
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const control = new NapcatLoginControl({ ...fixture, fetchImpl });

    await expect(control.status()).resolves.toMatchObject({
      isLogin: true,
      manualLogin: false,
      data: { user_id: 985436737 }
    });
    await expect(fs.access(fixture.manualLoginMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
    control.close();
  });
});

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-napcat-login-"));
  temporaryDirectories.push(directory);
  const webuiConfigPath = path.join(directory, "config", "webui.json");
  const qrCodePath = path.join(directory, "runtime", "qrcode.png");
  const manualLoginMarkerPath = path.join(directory, "runtime", "manual-login-required");
  const runtimeEnvPath = path.join(directory, "secrets", "runtime.env");
  await fs.mkdir(path.dirname(webuiConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(qrCodePath), { recursive: true });
  await fs.mkdir(path.dirname(runtimeEnvPath), { recursive: true });
  await fs.writeFile(webuiConfigPath, JSON.stringify({ port: 6099, token: "test-token" }));
  await fs.writeFile(runtimeEnvPath, "NAPCAT_ACCOUNT=\n", { mode: 0o600 });
  return { webuiConfigPath, qrCodePath, manualLoginMarkerPath, runtimeEnvPath };
}

function json(value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
}
