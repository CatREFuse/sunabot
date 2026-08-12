// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMatchingAdminPasswords,
  createAdminCredentialRecord,
  normalizeAdminUsername,
  readAdminCredentialRecord,
  validateAdminCredentialRecord,
  validateAdminPassword,
  writeAdminCredentialRecord
} from "../../tooling/admin/admin-credentials-core.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("admin credentials landing", () => {
  it("accepts normalized multilingual administrator names", () => {
    expect(normalizeAdminUsername("  管理员-01  ")).toBe("管理员-01");
    expect(() => normalizeAdminUsername("bad name")).toThrow(/管理员名称/u);
  });

  it("requires a strong matching password", () => {
    expect(validateAdminPassword("correct-horse-2026")).toBe("correct-horse-2026");
    expect(() => validateAdminPassword("short")).toThrow(/至少/u);
    expect(() => assertMatchingAdminPasswords("correct-horse-2026", "different-horse-2026"))
      .toThrow(/不一致/u);
  });

  it("creates a stable credential shape without retaining plaintext", async () => {
    const derive = vi.fn(async () => Buffer.alloc(64, 7));
    const record = await createAdminCredentialRecord({
      username: "管理员",
      password: "correct-horse-2026",
      previous: { createdAt: "2026-01-01T00:00:00.000Z" },
      now: new Date("2026-08-12T00:00:00.000Z"),
      randomBytes: () => Buffer.alloc(16, 3),
      derive
    });

    expect(record).toMatchObject({
      version: 1,
      username: "管理员",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      password: { algorithm: "scrypt", keyLength: 64 }
    });
    expect(JSON.stringify(record)).not.toContain("correct-horse-2026");
    expect(derive).toHaveBeenCalledWith("correct-horse-2026", expect.any(String), 64);
  });

  it("durably replaces the credential file with a private readable record", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-admin-credentials-"));
    temporaryDirectories.push(directory);
    const credentialsPath = path.join(directory, "secrets/admin-credentials.json");
    const record = validCredentialRecord();

    await writeAdminCredentialRecord(credentialsPath, record);

    await expect(readAdminCredentialRecord(credentialsPath)).resolves.toEqual(record);
    expect((await fs.stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(credentialsPath))).filter((entry) => entry.endsWith(".tmp")))
      .toEqual([]);
  });

  it("rejects credential records that AdminAuth cannot use", () => {
    expect(() => validateAdminCredentialRecord({
      ...validCredentialRecord(),
      password: { algorithm: "scrypt", salt: "invalid", hash: "invalid", keyLength: 64 }
    })).toThrow(/凭据文件格式无效/u);
  });
});

function validCredentialRecord() {
  return {
    version: 1,
    username: "管理员",
    password: {
      algorithm: "scrypt",
      salt: Buffer.alloc(16, 3).toString("base64url"),
      hash: Buffer.alloc(64, 7).toString("base64url"),
      keyLength: 64
    },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
}
