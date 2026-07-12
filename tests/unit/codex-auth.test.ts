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

  it("parses the current Codex CLI multiline device-code format", async () => {
    const { service } = await fixture();
    (service as unknown as { consumeOutput(value: string): void }).consumeOutput([
      "Welcome to Codex [v0.139.0]",
      "OpenAI's command-line coding agent",
      "",
      "Follow these steps to sign in with ChatGPT using device code authorization:",
      "1. Open https://auth.openai.com/codex/device",
      "2. Enter this one-time code (expires in 15 minutes)",
      "   158E-8N34D"
    ].join("\n"));
    const snapshot = await service.status();
    expect(snapshot.login).toMatchObject({
      state: "waiting",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "158E-8N34D"
    });
    expect(snapshot.login.userCode).not.toBe("command-line");
  });

  it("parses a device code without a hyphen", async () => {
    const { service } = await fixture();
    (service as unknown as { consumeOutput(value: string): void }).consumeOutput([
      "Open https://auth.openai.com/codex/device",
      "Enter this one-time code",
      "AB12CD34"
    ].join("\n"));
    expect((await service.status()).login.userCode).toBe("AB12CD34");
  });
});

function jwt(payload: Record<string, unknown>) {
  const part = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.signature`;
}
