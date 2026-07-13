// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdminSessionStore } from "../../adapters/sqlite/adminSessionStore.js";
import {
  AdminAuthService,
  hashAdminPassword,
  isAdminProtectedPath,
  isLoopbackAddress,
  type AdminCredentialRecord
} from "../../src/admin/auth.js";

const temporaryDirectories: string[] = [];
const dataStores: SqliteAdminSessionStore[] = [];

afterEach(async () => {
  for (const store of dataStores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("admin request authorization", () => {
  it("protects every API and generated image path", () => {
    expect(isAdminProtectedPath("/api/status?detail=1")).toBe(true);
    expect(isAdminProtectedPath("/generated-images/avatar.png")).toBe(true);
    expect(isAdminProtectedPath("/assets/app.js")).toBe(false);
  });

  it("recognizes IPv4, mapped IPv4 and IPv6 loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.8")).toBe(false);
  });

  it("uses an HttpOnly session and CSRF token instead of browser storage bearer credentials", async () => {
    const service = await createService();
    const reply = fakeReply();
    const status = await service.login(request({ method: "POST", origin: "http://127.0.0.1:8787" }), reply, {
      username: "admin",
      password: "correct-horse-battery-staple"
    });
    expect(status).toMatchObject({ authenticated: true, username: "admin", csrfToken: expect.any(String) });
    expect(reply.headers["set-cookie"]).toContain("HttpOnly");
    expect(reply.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(reply.headers["set-cookie"]).toContain("Max-Age=2592000");

    const cookie = String(reply.headers["set-cookie"]).split(";", 1)[0];
    await expect(service.authorize(request({ url: "/api/status", cookie }))).resolves.toBeUndefined();
    await expect(service.authorize(request({
      method: "POST",
      url: "/api/config",
      origin: "http://127.0.0.1:8787",
      cookie,
      csrf: status.csrfToken
    }))).resolves.toBeUndefined();
    await expect(service.authorize(request({ method: "POST", url: "/api/config", cookie }))).rejects.toMatchObject({
      statusCode: 403,
      code: "ADMIN_CSRF_INVALID"
    });
  });

  it("keeps bearer authentication for non-browser automation but removes loopback bypass", async () => {
    const service = await createService({ bearerToken: "automation-secret" });
    await expect(service.authorize(request({ url: "/api/status" }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.authorize(request({
      url: "/api/status",
      authorization: "Bearer automation-secret"
    }))).resolves.toBeUndefined();
  });

  it("restores a hashed cookie session from SQLite after the auth service restarts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-admin-auth-persistent-"));
    temporaryDirectories.push(directory);
    const credentialsPath = await writeCredentials(directory);
    const databasePath = path.join(directory, "sunabot.sqlite");
    const firstStore = new SqliteAdminSessionStore(databasePath);
    const first = await AdminAuthService.create({
      credentialsPath,
      fusePath: path.join(directory, "ADMIN_DISABLED.json"),
      sessionStore: firstStore
    });
    const reply = fakeReply();
    await first.login(request({ method: "POST", origin: "http://127.0.0.1:8787" }), reply, {
      username: "admin",
      password: "correct-horse-battery-staple"
    });
    const cookie = String(reply.headers["set-cookie"]).split(";", 1)[0];
    firstStore.close();

    const secondStore = new SqliteAdminSessionStore(databasePath);
    dataStores.push(secondStore);
    const second = await AdminAuthService.create({
      credentialsPath,
      fusePath: path.join(directory, "ADMIN_DISABLED.json"),
      sessionStore: secondStore
    });
    expect(second.getSessionStatus(request({ url: "/api/auth/session", cookie }))).toMatchObject({
      authenticated: true,
      username: "admin",
      csrfToken: expect.any(String)
    });
  });

  it("changes the password, rotates the current cookie and invalidates older sessions", async () => {
    const service = await createService();
    const loginReply = fakeReply();
    const login = await service.login(request({ method: "POST", origin: "http://127.0.0.1:8787" }), loginReply, {
      username: "admin",
      password: "correct-horse-battery-staple"
    });
    const oldCookie = String(loginReply.headers["set-cookie"]).split(";", 1)[0];

    await expect(service.changePassword(
      request({ method: "POST", url: "/api/auth/password", origin: "http://127.0.0.1:8787", cookie: oldCookie, csrf: login.csrfToken }),
      fakeReply(),
      { currentPassword: "wrong-password", newPassword: "new-correct-horse-battery", confirmPassword: "new-correct-horse-battery" }
    )).rejects.toMatchObject({ statusCode: 400, code: "ADMIN_CURRENT_PASSWORD_INVALID", field: "currentPassword" });

    const changeReply = fakeReply();
    const changed = await service.changePassword(
      request({ method: "POST", url: "/api/auth/password", origin: "http://127.0.0.1:8787", cookie: oldCookie, csrf: login.csrfToken }),
      changeReply,
      { currentPassword: "correct-horse-battery-staple", newPassword: "new-correct-horse-battery", confirmPassword: "new-correct-horse-battery" }
    );
    const newCookie = String(changeReply.headers["set-cookie"]).split(";", 1)[0];
    expect(changed).toMatchObject({ authenticated: true, csrfToken: expect.any(String) });
    expect(newCookie).not.toBe(oldCookie);
    await expect(service.authorize(request({ url: "/api/status", cookie: oldCookie }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.authorize(request({ url: "/api/status", cookie: newCookie }))).resolves.toBeUndefined();

    await expect(service.login(request({ method: "POST", origin: "http://127.0.0.1:8787" }), fakeReply(), {
      username: "admin",
      password: "correct-horse-battery-staple"
    })).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.login(request({ method: "POST", origin: "http://127.0.0.1:8787" }), fakeReply(), {
      username: "admin",
      password: "new-correct-horse-battery"
    })).resolves.toMatchObject({ authenticated: true });
  }, 30_000);

  it("locks repeated failures and trips the global automatic fuse", async () => {
    let now = 1_000_000;
    const service = await createService({ now: () => now, allowedOrigins: ["https://plana.example.com"] });
    const loginRequest = request({
      method: "POST",
      host: "plana.example.com",
      origin: "https://plana.example.com",
      forwardedFor: "203.0.113.8",
      forwardedProto: "https"
    });
    for (let index = 0; index < 5; index += 1) {
      await expect(service.login(loginRequest, fakeReply(), { username: "admin", password: "wrong-password" }))
        .rejects.toMatchObject({ statusCode: 401 });
      now += 1;
    }
    await expect(service.login(loginRequest, fakeReply(), { username: "admin", password: "wrong-password" }))
      .rejects.toMatchObject({ statusCode: 429, code: "ADMIN_LOGIN_LOCKED" });

    for (let source = 0; source < 4; source += 1) {
      const otherRequest = request({
        method: "POST",
        host: "plana.example.com",
        origin: "https://plana.example.com",
        forwardedFor: `203.0.113.${20 + source}`,
        forwardedProto: "https"
      });
      for (let index = 0; index < 5; index += 1) {
        await service.login(otherRequest, fakeReply(), { username: "admin", password: "wrong-password" }).catch(() => undefined);
      }
    }
    expect(service.getFuseStatus().automatic).toBe(true);
  }, 30_000);

  it("blocks forwarded management through the persistent manual fuse while keeping local recovery available", async () => {
    const service = await createService({ allowedOrigins: ["https://plana.example.com"] });
    await service.tripFuse("test");
    await expect(service.authorize(request({
      url: "/api/status",
      forwardedFor: "203.0.113.4",
      host: "plana.example.com"
    }))).rejects.toMatchObject({ statusCode: 503, code: "ADMIN_FUSE_TRIPPED" });
    expect(service.getFuseStatus().manual).toBe(true);
  });
});

async function createService(options: { bearerToken?: string; allowedOrigins?: string[]; now?: () => number } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-admin-auth-"));
  temporaryDirectories.push(directory);
  const credentialsPath = path.join(directory, "credentials.json");
  const timestamp = new Date().toISOString();
  const record: AdminCredentialRecord = {
    version: 1,
    username: "admin",
    password: await hashAdminPassword("correct-horse-battery-staple"),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await fs.writeFile(credentialsPath, JSON.stringify(record));
  return AdminAuthService.create({
    credentialsPath,
    fusePath: path.join(directory, "ADMIN_DISABLED.json"),
    ...options
  });
}

async function writeCredentials(directory: string) {
  const credentialsPath = path.join(directory, "credentials.json");
  const timestamp = new Date().toISOString();
  const record: AdminCredentialRecord = {
    version: 1,
    username: "admin",
    password: await hashAdminPassword("correct-horse-battery-staple"),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await fs.writeFile(credentialsPath, JSON.stringify(record));
  return credentialsPath;
}

function request(options: {
  method?: string;
  url?: string;
  remoteAddress?: string;
  host?: string;
  origin?: string;
  authorization?: string;
  forwardedFor?: string;
  forwardedProto?: string;
  cookie?: string;
  csrf?: string;
} = {}) {
  return {
    method: options.method ?? "GET",
    url: options.url ?? "/api/auth/login",
    protocol: "http",
    headers: {
      host: options.host ?? "127.0.0.1:8787",
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.forwardedFor ? { "x-forwarded-for": options.forwardedFor } : {}),
      ...(options.forwardedProto ? { "x-forwarded-proto": options.forwardedProto } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-sunabot-csrf": options.csrf } : {})
    },
    raw: { url: options.url ?? "/api/auth/login", socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" } }
  } as unknown as FastifyRequest;
}

function fakeReply() {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    header(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return this;
    }
  } as unknown as FastifyReply & { headers: Record<string, unknown> };
}
