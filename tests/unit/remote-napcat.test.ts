// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateRemoteNapcat, remoteSshArgs, remoteDockerInvocation, shellQuote,
  remoteNapcatFile, createRemoteLoginFiles, offlineNapcatImage, readRemoteNapcat
} from "../../packages/platform/remoteNapcat.mjs";
import { NapcatLoginControl } from "../../adapters/onebot/napcatLoginControl.js";

const roots: string[] = [];
const remote = {
  version: 1, host: "ecs.example.test", user: "sunabot-napcat", port: 22,
  uid: 1003, gid: 1003, gateway: "172.30.77.1", root: "/home/sunabot-napcat/runtime",
  identityFile: path.resolve("test-key"), knownHostsFile: path.resolve("test-known-hosts")
};
const png = Buffer.from("89504e470d0a1a0a010203", "hex");

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("remote NapCat", () => {
  it("keeps local deployment opt-in and validates remote transport configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-napcat-"));
    roots.push(root);
    expect(await readRemoteNapcat(root)).toBeUndefined();
    expect(validateRemoteNapcat(remote)).toEqual(remote);
    for (const patch of [
      { user: "root" }, { user: "x;id" }, { host: "-oProxyCommand=x" }, { uid: 0 },
      { gateway: "0.0.0.0" }, { gateway: "8.8.8.8" }, { root: "/tmp/../etc" }, { port: 0 }
    ]) expect(() => validateRemoteNapcat({ ...remote, ...patch })).toThrow("REMOTE_NAPCAT_CONFIG_INVALID");
    expect(remoteSshArgs(remote)).toContain("StrictHostKeyChecking=yes");
    expect(remoteSshArgs(remote)).toContain("BatchMode=yes");
    expect(shellQuote("x'$(id)")).toBe("'x'\\''$(id)'");
    const invocation = remoteDockerInvocation(remote, ["logs", "a';echo nope"]);
    expect(invocation.executable).toBe("ssh");
    expect(invocation.args.at(-1)).toContain("'a'\\'';echo nope'");
  });

  it("verifies every digest from locked multi-platform index to offline config ID", () => {
    const hash = (value: Buffer) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
    const configId = `sha256:${"a".repeat(64)}`;
    const manifest = Buffer.from(JSON.stringify({ config: { digest: configId } }));
    const index = Buffer.from(JSON.stringify({ manifests: [{
      platform: { os: "linux", architecture: "amd64" }, digest: hash(manifest)
    }] }));
    const locked = `example/napcat@${hash(index)}`;
    expect(offlineNapcatImage(index, manifest, locked, "amd64")).toBe(configId);
    expect(() => offlineNapcatImage(Buffer.from("{}"), manifest, locked, "amd64")).toThrow("INDEX_MISMATCH");
    expect(() => offlineNapcatImage(index, Buffer.from("{}"), locked, "amd64")).toThrow("MANIFEST_MISMATCH");
    expect(() => offlineNapcatImage(index, manifest, locked, "arm64")).toThrow("MANIFEST_MISMATCH");
  });

  it.skipIf(process.platform === "win32")("executes remote file protocol, preserves QR age and refuses path escapes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-napcat-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "ssh"), '#!/bin/bash\nexec /bin/sh -c "${@: -1}"\n', { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const target = { ...remote, root: path.join(root, "server") };
    const files = createRemoteLoginFiles(target, "account_1");
    expect(await files.read("qrcode.png")).toBeUndefined();
    await files.write("qrcode.png", png);
    expect((await files.read("qrcode.png"))?.data).toEqual(png);
    const qr = path.join(target.root, "workspace/runtime/napcat/accounts/account_1/qrcode.png");
    const old = new Date(Date.now() - 65_000);
    await fs.utimes(qr, old, old);
    expect((await files.read("qrcode.png"))?.mtimeMs).toBeCloseTo(old.getTime(), 0);
    await expect(remoteNapcatFile(target, "../escape", "read")).rejects.toThrow("PATH_INVALID");
    await fs.symlink(root, path.join(target.root, "escape"));
    await expect(remoteNapcatFile(target, "escape/outside", "write", "bad")).rejects.toThrow("PATH_ESCAPE");
    await files.remove("qrcode.png");
    expect(await files.read("qrcode.png")).toBeUndefined();
    await expect(remoteNapcatFile(target, "workspace", "remove-account")).rejects.toThrow("ACCOUNT_PATH_INVALID");
    await files.write("account.env", "NAPCAT_ACCOUNT=123456");
    await remoteNapcatFile(target, "workspace/runtime/napcat/accounts/account_1", "remove-account");
    expect(await files.read("account.env")).toBeUndefined();
    await fs.writeFile(path.join(bin, "ssh"), "#!/bin/sh\nexit 255\n", { mode: 0o700 });
    await expect(files.read("qrcode.png")).rejects.toThrow();
  });

  it("uses remote QR and markers instead of stale local files, and surfaces transport errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-napcat-"));
    roots.push(root);
    const webuiConfigPath = path.join(root, "webui.json");
    await fs.writeFile(webuiConfigPath, JSON.stringify({ token: "synthetic", port: 6099 }));
    const entries = new Map<string, { data: Buffer; mtimeMs: number }>([
      ["qrcode.png", { data: png, mtimeMs: Date.now() - 65_000 }]
    ]);
    const loginFiles = {
      read: vi.fn(async (name: string) => entries.get(name)),
      write: vi.fn(async (name: string, data: string) => {
        entries.set(name, { data: Buffer.from(data), mtimeMs: Date.now() });
      }),
      remove: vi.fn(async (name: string) => { entries.delete(name); })
    };
    const control = new NapcatLoginControl({
      webuiConfigPath, qrCodePath: path.join(root, "local-qr"),
      manualLoginMarkerPath: path.join(root, "local-marker"),
      runtimeEnvPath: path.join(root, "local-env"), loginFiles,
      fetchImpl: async (input) => {
        const route = new URL(input).pathname;
        if (route.endsWith("RefreshQRcode")) entries.set("qrcode.png", {
          data: Buffer.concat([png, Buffer.from("new")]), mtimeMs: Date.now()
        });
        return new Response(JSON.stringify({ code: 0, data: route.endsWith("/auth/login")
          ? { Credential: "test" } : { isLogin: false } }));
      }
    });
    expect((await control.status()).imageDataUrl).toBeUndefined();
    expect((await control.refreshQrCode()).imageDataUrl).toContain("data:image/png;base64,");
    await control.beginManualLogin();
    expect(entries.has("manual-login-required")).toBe(true);
    expect(entries.has("qrcode.png")).toBe(false);
    expect(await fs.readdir(root)).toEqual(["webui.json"]);
    await control.cancelManualLogin();
    expect(entries.has("manual-login-required")).toBe(false);
    loginFiles.read.mockRejectedValue(new Error("SSH disconnected"));
    await expect(control.status()).rejects.toThrow("SSH disconnected");
    control.close();
  });
});
