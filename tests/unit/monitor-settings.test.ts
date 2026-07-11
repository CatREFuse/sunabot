// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorSettingsStore } from "../../src/admin/monitorSettings.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-monitor-"));
  roots.push(root);
  return { root, envPath: path.join(root, ".env"), store: new MonitorSettingsStore(path.join(root, ".env")) };
}

describe("MonitorSettingsStore", () => {
  it("stores Bark only in the workspace env and never returns its URL", async () => {
    const { store, envPath } = await createStore();
    const result = await store.update({ barkUrl: "https://bark.example.test/device-key", aggregationWindowSeconds: 90 });
    expect(result).toMatchObject({ barkConfigured: true, aggregationWindowSeconds: 90 });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(await fs.readFile(envPath, "utf8")).toContain("BARK_URL=https://bark.example.test/device-key");
  });

  it("rejects non-loopback plain HTTP Bark endpoints", async () => {
    const { store } = await createStore();
    await expect(store.update({ barkUrl: "http://example.com/key" })).rejects.toThrow(/HTTPS/);
  });

  it("preserves an existing Bark URL when the WebUI input is blank", async () => {
    const { store } = await createStore();
    await store.update({ barkUrl: "https://bark.example.test/device-key" });
    await store.update({ barkUrl: "", serverEventsEnabled: false });
    expect((await store.runtimeSettings()).barkUrl).toBe("https://bark.example.test/device-key");
  });
});
