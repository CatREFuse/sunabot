// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAuthService } from "../../src/admin/codexAuth.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-auth-"));
  roots.push(root);
  const service = new CodexAuthService({ codexHome: root, executable: "codex-test" });
  vi.spyOn(service as never, "isInstalled").mockResolvedValue(true);
  return { root, service };
}

describe("CodexAuthService", () => {
  it("reports a valid ChatGPT subscription without returning its token", async () => {
    const { root, service } = await fixture();
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, secretMarker: "never-return-this" });
    await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token } }));
    const snapshot = await service.status();
    expect(snapshot).toMatchObject({ installed: true, authenticated: true, method: "chatgpt" });
    expect(snapshot.expiresAt).toBeTruthy();
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(JSON.stringify(snapshot)).not.toContain("never-return-this");
  });

  it("extracts only the device verification URL and user code from CLI output", async () => {
    const { service } = await fixture();
    (service as unknown as { consumeOutput(value: string): void }).consumeOutput(
      "Open https://auth.openai.com/device and enter code ABCD-EFGH\nBearer super-secret-token"
    );
    const snapshot = await service.status();
    expect(snapshot.login).toMatchObject({
      state: "waiting",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH"
    });
    expect(JSON.stringify(snapshot)).not.toContain("super-secret-token");
  });
});

function jwt(payload: Record<string, unknown>) {
  const part = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.signature`;
}
