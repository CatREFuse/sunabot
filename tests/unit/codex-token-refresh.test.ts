import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodexAccessToken } from "../../packages/platform/codexTokenRefresh.mjs";

describe("Codex managed token refresh", () => {
  it("reuses an access token that is not near expiry", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "sunabot-codex-auth-"));
    const authFile = path.join(codexHome, "auth.json");
    const token = jwt(Math.floor(Date.now() / 1_000) + 3_600);
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: token } }));

    await expect(ensureCodexAccessToken({
      authFile,
      codexHome,
      command: path.join(codexHome, "missing-codex")
    })).resolves.toBe(token);
  });

  it.each([
    ["expired", -60],
    ["near expiry", 30]
  ])("uses app-server account/read to refresh an %s token", async (_label, expiresInSeconds) => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "sunabot-codex-auth-"));
    const authFile = path.join(codexHome, "auth.json");
    const previous = jwt(Math.floor(Date.now() / 1_000) + expiresInSeconds);
    const refreshed = jwt(Math.floor(Date.now() / 1_000) + 3_600);
    const fakeServer = path.join(codexHome, "fake-app-server.mjs");
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: previous, refresh_token: "refresh" } }));
    await writeFile(fakeServer, `
      import fs from "node:fs";
      import readline from "node:readline";
      const input = readline.createInterface({ input: process.stdin });
      input.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
        if (message.id === 2) {
          fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify({ tokens: { access_token: ${JSON.stringify(refreshed)}, refresh_token: "refresh-2" } }));
          process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: "chatgpt" } } }) + "\\n");
        }
      });
    `);

    await expect(ensureCodexAccessToken({
      authFile,
      codexHome,
      command: process.execPath,
      args: [fakeServer]
    })).resolves.toBe(refreshed);
    const saved = JSON.parse(await readFile(authFile, "utf8"));
    expect(saved.tokens.access_token).toBe(refreshed);
  });

  it.each([
    ["malformed", "not-a-jwt"],
    ["missing exp", jwtPayload({ sub: "account" })],
    ["non-numeric exp", jwtPayload({ exp: "never" })]
  ])("refreshes a %s access token", async (_label, previous) => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "sunabot-codex-auth-invalid-"));
    const authFile = path.join(codexHome, "auth.json");
    const refreshed = jwt(Math.floor(Date.now() / 1_000) + 3_600);
    const fakeServer = path.join(codexHome, "fake-refresh-invalid.mjs");
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: previous } }));
    await writeFile(fakeServer, `
      import fs from "node:fs";
      import readline from "node:readline";
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
        if (message.id === 2) {
          fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify({ tokens: { access_token: ${JSON.stringify(refreshed)} } }));
          process.stdout.write(JSON.stringify({ id: 2, result: {} }) + "\\n");
        }
      });
    `);

    await expect(ensureCodexAccessToken({
      authFile,
      codexHome,
      command: process.execPath,
      args: [fakeServer]
    })).resolves.toBe(refreshed);
  });

  it("terminates the managed app-server process after a successful refresh", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "sunabot-codex-auth-stubborn-"));
    const authFile = path.join(codexHome, "auth.json");
    const refreshed = jwt(Math.floor(Date.now() / 1_000) + 3_600);
    const fakeServer = path.join(codexHome, "fake-refresh-stubborn.mjs");
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: "malformed" } }));
    await writeFile(fakeServer, `
      import fs from "node:fs";
      import readline from "node:readline";
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 10_000);
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
        if (message.id === 2) {
          fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify({ tokens: { access_token: ${JSON.stringify(refreshed)} } }));
          process.stdout.write(JSON.stringify({ id: 2, result: {} }) + "\\n");
        }
      });
    `);

    await expect(ensureCodexAccessToken({
      authFile,
      codexHome,
      command: process.execPath,
      args: [fakeServer],
      timeoutMs: 5_000
    })).resolves.toBe(refreshed);
  }, 6_000);
});

function jwt(exp: number) {
  return jwtPayload({ exp });
}

function jwtPayload(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}
