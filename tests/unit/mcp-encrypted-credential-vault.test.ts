// @vitest-environment node
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedFileMcpCredentialVault } from "../../adapters/mcp/encryptedCredentialVault.js";

const TEST_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/oauth-vault";

describe("encrypted MCP credential vault", () => {
  let root = "";
  let filePath = "";
  let now = 100_000;
  const key = Buffer.alloc(32, 0x2a);
  const binding = {
    agentId: "agent-a",
    serverId: "server-a",
    subject: "account-a",
    resource: "https://mcp.example.test/mcp"
  };

  beforeEach(async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
    await fs.chmod(TEST_ROOT, 0o700);
    root = await fs.mkdtemp(path.join(TEST_ROOT, "run-"));
    await fs.chmod(root, 0o700);
    filePath = path.join(root, "credentials.json");
    now = 100_000;
  });

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("encrypts tokens, bindings, and OAuth registration in a private atomic file", async () => {
    const vault = createVault();
    const handle = await vault.storeOAuth(binding, {
      accessToken: "access-do-not-store-in-plaintext",
      refreshToken: "refresh-do-not-store-in-plaintext",
      expiresAt: now + 60_000
    }, {
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "private-client-reference"
    });

    expect(handle).toMatch(/^mcpcred_[A-Za-z0-9_-]+$/u);
    const raw = await fs.readFile(filePath, "utf8");
    for (const secret of [
      "access-do-not-store-in-plaintext",
      "refresh-do-not-store-in-plaintext",
      "agent-a",
      "server-a",
      "account-a",
      "mcp.example.test",
      "auth.example.test",
      "private-client-reference"
    ]) expect(raw).not.toContain(secret);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const restarted = createVault();
    await expect(restarted.resolve(handle, binding)).resolves.toEqual({
      accessToken: "access-do-not-store-in-plaintext",
      refreshToken: "refresh-do-not-store-in-plaintext",
      expiresAt: now + 60_000
    });
    await expect(restarted.resolveForRefresh(handle, binding)).resolves.toMatchObject({
      oauth: {
        tokenEndpoint: "https://auth.example.test/token",
        clientId: "private-client-reference"
      }
    });
  });

  it.each([
    { agentId: "agent-b" },
    { serverId: "server-b" },
    { subject: "account-b" },
    { resource: "https://other.example.test/mcp" }
  ])("rejects a mismatched credential partition %#", async (mismatch) => {
    const vault = createVault();
    const handle = await vault.store(binding, { accessToken: "secret" });
    await expect(vault.resolve(handle, { ...binding, ...mismatch })).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
    await expect(vault.remove(handle, { ...binding, ...mismatch })).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
    await expect(vault.resolve(handle, binding)).resolves.toMatchObject({ accessToken: "secret" });
  });

  it("rejects expired access while preserving refresh material for an explicit rotation", async () => {
    const vault = createVault();
    const handle = await vault.storeOAuth(binding, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: now + 10
    }, {
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "client-a"
    });
    const refresh = await vault.resolveForRefresh(handle, binding);
    now += 10;
    await expect(vault.resolve(handle, binding)).rejects.toThrow("MCP_CREDENTIAL_EXPIRED");
    await expect(vault.resolveForRefresh(handle, binding)).resolves.toMatchObject({
      tokens: { refreshToken: "old-refresh" }
    });

    const revision = await vault.rotateOAuth(handle, binding, refresh.revision, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: now + 60_000
    });
    expect(revision).not.toBe(refresh.revision);
    await expect(vault.rotateOAuth(handle, binding, refresh.revision, {
      accessToken: "stale-writer"
    })).rejects.toThrow("MCP_CREDENTIAL_CONFLICT");
    await expect(vault.resolve(handle, binding)).resolves.toMatchObject({ accessToken: "new-access" });
  });

  it("deletes only an exactly bound handle", async () => {
    const vault = createVault();
    const handle = await vault.store(binding, { accessToken: "secret" });
    await vault.remove(handle, binding);
    await expect(vault.resolve(handle, binding)).rejects.toThrow("MCP_CREDENTIAL_UNAVAILABLE");
  });

  it("serializes concurrent stores without losing a record", async () => {
    const vault = createVault();
    const [first, second] = await Promise.all([
      vault.store(binding, { accessToken: "first" }),
      vault.store({ ...binding, serverId: "server-b" }, { accessToken: "second" })
    ]);
    await expect(vault.resolve(first, binding)).resolves.toMatchObject({ accessToken: "first" });
    await expect(vault.resolve(second, { ...binding, serverId: "server-b" })).resolves.toMatchObject({ accessToken: "second" });
  });

  it("fails closed for an incorrect key or authenticated ciphertext tampering", async () => {
    const vault = createVault();
    const handle = await vault.store(binding, { accessToken: "secret" });
    const wrongKey = new EncryptedFileMcpCredentialVault({ filePath, key: Buffer.alloc(32, 0x51), now: () => now });
    await expect(wrongKey.resolve(handle, binding)).rejects.toThrow("MCP_CREDENTIAL_VAULT_CORRUPT");

    const document = JSON.parse(await fs.readFile(filePath, "utf8"));
    const ciphertext = document.records[handle].ciphertext as string;
    document.records[handle].ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await fs.writeFile(filePath, JSON.stringify(document), { mode: 0o600 });
    await expect(vault.resolve(handle, binding)).rejects.toThrow("MCP_CREDENTIAL_VAULT_CORRUPT");
  });

  it("rejects a symlink vault, a wide vault file, and a wide parent directory", async () => {
    const target = path.join(root, "outside.json");
    await fs.writeFile(target, "{}", { mode: 0o600 });
    await fs.symlink(target, filePath);
    await expect(createVault().store(binding, { accessToken: "secret" }))
      .rejects.toThrow("MCP_CREDENTIAL_VAULT_PERMISSIONS");

    await fs.unlink(filePath);
    await fs.writeFile(filePath, "{}", { mode: 0o644 });
    await expect(createVault().store(binding, { accessToken: "secret" }))
      .rejects.toThrow("MCP_CREDENTIAL_VAULT_PERMISSIONS");

    await fs.unlink(filePath);
    await fs.chmod(root, 0o755);
    await expect(createVault().store(binding, { accessToken: "secret" }))
      .rejects.toThrow("MCP_CREDENTIAL_VAULT_PERMISSIONS");
  });

  it("requires an absolute path and an explicit 32-byte AES key", () => {
    expect(() => new EncryptedFileMcpCredentialVault({ filePath: "relative.json", key }))
      .toThrow("MCP_CREDENTIAL_VAULT_PATH_INVALID");
    expect(() => new EncryptedFileMcpCredentialVault({ filePath, key: Buffer.alloc(31) }))
      .toThrow("MCP_CREDENTIAL_VAULT_KEY_INVALID");
  });

  function createVault() {
    return new EncryptedFileMcpCredentialVault({ filePath, key, now: () => now });
  }
});
