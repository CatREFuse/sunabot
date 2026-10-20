import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeNapcatConnection } from "../../apps/api/napcatConnection.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("NapCat connection display", () => {
  it("describes the actual local listener, including custom port and IPv6", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "connection-"));
    directories.push(root);
    expect(await describeNapcatConnection(root, { host: "::1", port: 9123 }, "/bot/ws")).toEqual({
      mode: "local", host: os.hostname(), transport: "direct",
      onebotUrl: "ws://[::1]:9123/bot/ws", onebotPort: 9123, coreUrl: "ws://[::1]:9123/bot/ws"
    });
  });

  it("shows the remote gateway separately from Core without returning SSH secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "connection-"));
    directories.push(root);
    await fs.mkdir(path.join(root, "secrets"));
    await fs.writeFile(path.join(root, "secrets/remote-napcat.json"), JSON.stringify({
      version: 1, host: "ecs.example.test", port: 22, user: "napcat", uid: 1003, gid: 1003,
      gateway: "172.30.77.1", root: "/home/napcat/runtime",
      identityFile: path.join(root, "private-key"), knownHostsFile: path.join(root, "known-hosts"),
      token: "must-not-leak"
    }));
    expect(await describeNapcatConnection(root, { host: "127.0.0.1", port: 8788 }, "/onebot/v11/ws")).toEqual({
      mode: "remote", host: "ecs.example.test", transport: "ssh",
      onebotUrl: "ws://172.30.77.1:8788/onebot/v11/ws", onebotPort: 8788,
      coreUrl: "ws://127.0.0.1:8788/onebot/v11/ws"
    });
  });

  it("does not mislabel a broken remote configuration as local", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "connection-"));
    directories.push(root);
    await fs.mkdir(path.join(root, "secrets"));
    await fs.writeFile(path.join(root, "secrets/remote-napcat.json"), "{}");
    await expect(describeNapcatConnection(root, { host: "127.0.0.1", port: 8788 }, "/ws")).rejects.toThrow("REMOTE_NAPCAT_CONFIG_INVALID");
  });
});
