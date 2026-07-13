import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AdminApiError } from "./errors.js";

const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip"] as const;
const SESSION_COOKIE = "sunabot_admin_session";
const SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
const SESSION_MAX_MS = 30 * 24 * 60 * 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const FAILURE_LOCK_MS = 30 * 60_000;
const GLOBAL_FAILURE_WINDOW_MS = 10 * 60_000;
const GLOBAL_FAILURE_LIMIT = 20;
const AUTOMATIC_FUSE_MS = 15 * 60_000;
const MAX_SESSIONS = 12;

export interface AdminCredentialRecord {
  version: 1;
  username: string;
  password: {
    algorithm: "scrypt";
    salt: string;
    hash: string;
    keyLength: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AdminSessionRecord {
  tokenHash: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AdminSessionStore {
  readAdminSession(tokenHash: string): AdminSessionRecord | undefined;
  saveAdminSession(session: AdminSessionRecord): void;
  deleteAdminSession(tokenHash: string): void;
  clearAdminSessions(): void;
  pruneAdminSessions(now: number, idleCutoff: number, maxSessions: number): void;
}

interface FailureBucket {
  failures: number[];
  lockedUntil?: number;
}

export interface AdminAuthOptions {
  credentialsPath: string;
  fusePath: string;
  bearerToken?: string;
  allowedOrigins?: string[];
  now?: () => number;
  sessionStore?: AdminSessionStore;
}

export interface AdminSessionStatus {
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
  expiresAt?: string;
}

export function isAdminProtectedPath(url: string) {
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/generated-images" ||
    pathname.startsWith("/generated-images/");
}

export function isAdminPublicPath(url: string) {
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname === "/api/auth/login" || pathname === "/api/auth/session";
}

export class AdminAuthService {
  private readonly sessions = new Map<string, AdminSessionRecord>();
  private readonly failures = new Map<string, FailureBucket>();
  private readonly globalFailures: number[] = [];
  private readonly now: () => number;
  private credentials?: AdminCredentialRecord;
  private automaticFuseUntil = 0;

  private constructor(private readonly options: AdminAuthOptions) {
    this.now = options.now ?? Date.now;
  }

  static async create(options: AdminAuthOptions) {
    const service = new AdminAuthService(options);
    await service.reloadCredentials();
    return service;
  }

  async reloadCredentials() {
    try {
      const raw = await fs.readFile(this.options.credentialsPath, "utf8");
      this.credentials = validateCredentialRecord(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.credentials = undefined;
    }
  }

  async authorize(request: FastifyRequest) {
    if (!isAdminProtectedPath(request.raw.url ?? request.url) || isAdminPublicPath(request.url)) return;
    this.assertFuseAllows(request);

    const bearer = bearerToken(request.headers.authorization);
    const configuredBearer = this.options.bearerToken?.trim() ?? "";
    if (bearer && configuredBearer && constantTimeEqual(bearer, configuredBearer)) return;

    const session = this.readSession(request);
    if (!session) throw unauthorized();
    if (!isSafeMethod(request.method)) {
      this.assertAllowedOrigin(request);
      const csrf = stringHeader(request.headers["x-sunabot-csrf"]);
      if (!csrf || !constantTimeEqual(csrf, session.csrfToken)) {
        throw new AdminApiError(403, "ADMIN_CSRF_INVALID", "管理请求的 CSRF 校验失败。");
      }
    }
  }

  getSessionStatus(request: FastifyRequest): AdminSessionStatus {
    const session = this.readSession(request);
    if (!session || !this.credentials) return { authenticated: false };
    return {
      authenticated: true,
      username: this.credentials.username,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  async login(request: FastifyRequest, reply: FastifyReply, body: unknown): Promise<AdminSessionStatus> {
    this.assertAllowedOrigin(request);
    this.assertFuseAllows(request);
    if (!this.credentials) {
      throw new AdminApiError(503, "ADMIN_SETUP_REQUIRED", "管理员账号尚未初始化，请先在本机执行初始化命令。");
    }

    const source = clientKey(request);
    const now = this.now();
    const bucket = this.failures.get(source) ?? { failures: [] };
    bucket.failures = bucket.failures.filter((timestamp) => now - timestamp <= FAILURE_WINDOW_MS);
    if ((bucket.lockedUntil ?? 0) > now) {
      reply.header("retry-after", String(Math.max(1, Math.ceil((bucket.lockedUntil! - now) / 1000))));
      throw new AdminApiError(429, "ADMIN_LOGIN_LOCKED", "登录尝试过多，请稍后再试。");
    }

    const value = body as { username?: unknown; password?: unknown } | null;
    const username = typeof value?.username === "string" ? value.username.trim() : "";
    const password = typeof value?.password === "string" ? value.password : "";
    const usernameMatches = username.length <= 128 && constantTimeEqual(username, this.credentials.username);
    const passwordMatches = password.length <= 1024 && await verifyAdminPassword(password, this.credentials);
    if (!usernameMatches || !passwordMatches) {
      this.recordFailure(source, bucket, now);
      throw unauthorized("管理员账号或密码无效。");
    }

    this.failures.delete(source);
    const session = this.createSession(now);
    reply.header("set-cookie", serializeSessionCookie(session.id, request, SESSION_MAX_MS));
    return this.sessionStatus(session.record);
  }

  logout(request: FastifyRequest, reply: FastifyReply) {
    const id = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (id) this.deleteSession(sessionTokenHash(id));
    reply.header("set-cookie", clearSessionCookie(request));
  }

  async changePassword(request: FastifyRequest, reply: FastifyReply, body: unknown): Promise<AdminSessionStatus> {
    if (!this.credentials) {
      throw new AdminApiError(503, "ADMIN_SETUP_REQUIRED", "管理员账号尚未初始化，请先在本机执行初始化命令。");
    }
    const value = body as { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown } | null;
    const currentPassword = typeof value?.currentPassword === "string" ? value.currentPassword : "";
    const newPassword = typeof value?.newPassword === "string" ? value.newPassword : "";
    const confirmPassword = typeof value?.confirmPassword === "string" ? value.confirmPassword : "";
    if (!await verifyAdminPassword(currentPassword, this.credentials)) {
      throw new AdminApiError(400, "ADMIN_CURRENT_PASSWORD_INVALID", "当前密码不正确。", "currentPassword");
    }
    if (newPassword.length < 12) {
      throw new AdminApiError(400, "ADMIN_PASSWORD_TOO_SHORT", "新密码至少需要 12 个字符。", "newPassword");
    }
    if (newPassword.length > 1024) {
      throw new AdminApiError(400, "ADMIN_PASSWORD_TOO_LONG", "新密码过长。", "newPassword");
    }
    if (newPassword !== confirmPassword) {
      throw new AdminApiError(400, "ADMIN_PASSWORD_MISMATCH", "两次输入的新密码不一致。", "confirmPassword");
    }

    const now = this.now();
    const next: AdminCredentialRecord = {
      ...this.credentials,
      password: await hashAdminPassword(newPassword),
      updatedAt: new Date(now).toISOString()
    };
    await writeCredentialRecord(this.options.credentialsPath, next);
    this.credentials = next;
    this.clearSessions();
    const session = this.createSession(now);
    reply.header("set-cookie", serializeSessionCookie(session.id, request, SESSION_MAX_MS));
    return this.sessionStatus(session.record);
  }

  async tripFuse(reason = "manual") {
    await fs.mkdir(path.dirname(this.options.fusePath), { recursive: true });
    const temporary = `${this.options.fusePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ trippedAt: new Date().toISOString(), reason }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(temporary, this.options.fusePath);
    this.clearSessions();
  }

  getFuseStatus() {
    const now = this.now();
    return {
      manual: existsSync(this.options.fusePath),
      automatic: this.automaticFuseUntil > now,
      automaticUntil: this.automaticFuseUntil > now ? new Date(this.automaticFuseUntil).toISOString() : undefined
    };
  }

  private readSession(request: FastifyRequest) {
    const id = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (!id) return undefined;
    const tokenHash = sessionTokenHash(id);
    const session = this.options.sessionStore?.readAdminSession(tokenHash) ?? this.sessions.get(tokenHash);
    if (!session) return undefined;
    const now = this.now();
    if (session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_MS) {
      this.deleteSession(tokenHash);
      return undefined;
    }
    if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      session.lastSeenAt = now;
      this.saveSession(session);
    }
    return session;
  }

  private createSession(now: number) {
    this.pruneSessions(now);
    const id = crypto.randomBytes(32).toString("base64url");
    const record: AdminSessionRecord = {
      tokenHash: sessionTokenHash(id),
      csrfToken: crypto.randomBytes(24).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_MAX_MS
    };
    this.saveSession(record);
    this.pruneSessions(now);
    return { id, record };
  }

  private pruneSessions(now: number) {
    this.options.sessionStore?.pruneAdminSessions(now, now - SESSION_IDLE_MS, MAX_SESSIONS);
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_MS) this.sessions.delete(session.tokenHash);
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const excess = [...this.sessions.values()]
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(MAX_SESSIONS);
      for (const session of excess) this.sessions.delete(session.tokenHash);
    }
  }

  private saveSession(session: AdminSessionRecord) {
    if (this.options.sessionStore) this.options.sessionStore.saveAdminSession(session);
    else this.sessions.set(session.tokenHash, session);
  }

  private deleteSession(tokenHash: string) {
    if (this.options.sessionStore) this.options.sessionStore.deleteAdminSession(tokenHash);
    else this.sessions.delete(tokenHash);
  }

  private clearSessions() {
    if (this.options.sessionStore) this.options.sessionStore.clearAdminSessions();
    this.sessions.clear();
  }

  private sessionStatus(session: AdminSessionRecord): AdminSessionStatus {
    return {
      authenticated: true,
      username: this.credentials?.username,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  private recordFailure(source: string, bucket: FailureBucket, now: number) {
    bucket.failures.push(now);
    if (bucket.failures.length >= 5) bucket.lockedUntil = now + FAILURE_LOCK_MS;
    this.failures.set(source, bucket);
    this.globalFailures.push(now);
    while (this.globalFailures[0] != null && now - this.globalFailures[0] > GLOBAL_FAILURE_WINDOW_MS) {
      this.globalFailures.shift();
    }
    if (this.globalFailures.length >= GLOBAL_FAILURE_LIMIT) {
      this.automaticFuseUntil = now + AUTOMATIC_FUSE_MS;
      this.globalFailures.length = 0;
      this.clearSessions();
    }
  }

  private assertAllowedOrigin(request: FastifyRequest) {
    const origin = stringHeader(request.headers.origin);
    if (!origin) {
      if (isDirectLoopbackRequest(request)) return;
      throw new AdminApiError(403, "ADMIN_ORIGIN_REQUIRED", "管理请求缺少可信 Origin。");
    }
    if (isLoopbackOrigin(origin) && isDirectLoopbackRequest(request)) return;
    const allowed = this.options.allowedOrigins ?? [];
    if (!allowed.some((item) => normalizeOrigin(item) === normalizeOrigin(origin))) {
      throw new AdminApiError(403, "ADMIN_ORIGIN_REJECTED", "管理请求来源不受信任。");
    }
  }

  private assertFuseAllows(request: FastifyRequest) {
    if (!isExternalRequest(request)) return;
    const now = this.now();
    if (existsSync(this.options.fusePath)) {
      throw new AdminApiError(503, "ADMIN_FUSE_TRIPPED", "远程管理入口已被紧急熔断。");
    }
    if (this.automaticFuseUntil > now) {
      throw new AdminApiError(503, "ADMIN_FUSE_AUTOMATIC", "远程管理入口因异常登录已临时熔断。");
    }
  }
}

export async function hashAdminPassword(password: string, salt = crypto.randomBytes(16).toString("base64url")) {
  if (password.length < 12) throw new Error("管理员密码至少需要 12 个字符。");
  if (password.length > 1024) throw new Error("管理员密码过长。");
  const keyLength = 64;
  const derived = await derivePassword(password, salt, keyLength);
  return { algorithm: "scrypt" as const, salt, hash: derived.toString("base64url"), keyLength };
}

export async function verifyAdminPassword(password: string, record: AdminCredentialRecord) {
  if (!password || record.password.algorithm !== "scrypt") return false;
  const derived = await derivePassword(password, record.password.salt, record.password.keyLength);
  return constantTimeEqualBytes(derived, Buffer.from(record.password.hash, "base64url"));
}

export function isLoopbackAddress(input: string) {
  const value = input.trim().toLowerCase().split("%", 1)[0] ?? "";
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  const parts = ipv4.split(".");
  return parts.length === 4 && Number(parts[0]) === 127 && parts.every(validIpv4Part);
}

function validateCredentialRecord(value: unknown): AdminCredentialRecord {
  const record = value as Partial<AdminCredentialRecord>;
  if (record.version !== 1 || typeof record.username !== "string" || !record.username.trim() ||
    record.password?.algorithm !== "scrypt" || typeof record.password.salt !== "string" ||
    typeof record.password.hash !== "string" || record.password.keyLength !== 64) {
    throw new Error("管理员凭据文件格式无效。");
  }
  return record as AdminCredentialRecord;
}

function isDirectLoopbackRequest(request: FastifyRequest) {
  if (FORWARDED_HEADERS.some((header) => request.headers[header] != null)) return false;
  return isLoopbackAddress(request.raw.socket.remoteAddress ?? "") && isLoopbackHost(request.headers.host);
}

function isExternalRequest(request: FastifyRequest) {
  return !isDirectLoopbackRequest(request);
}

function isLoopbackHost(host: string | undefined) {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "localhost" || hostname.endsWith(".localhost") || isLoopbackAddress(stripBrackets(hostname));
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || isLoopbackAddress(url.hostname));
  } catch {
    return false;
  }
}

function normalizeOrigin(origin: string) {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return "";
  }
}

function clientKey(request: FastifyRequest) {
  const forwarded = stringHeader(request.headers["x-forwarded-for"]);
  if (isLoopbackAddress(request.raw.socket.remoteAddress ?? "") && forwarded) {
    const first = forwarded.split(",", 1)[0]?.trim();
    if (first && first.length <= 64) return `proxy:${first}`;
  }
  return `peer:${request.raw.socket.remoteAddress ?? "unknown"}`;
}

function serializeSessionCookie(id: string, request: FastifyRequest, maxAgeMs: number) {
  const secure = requestIsHttps(request);
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ].filter(Boolean).join("; ");
}

function clearSessionCookie(request: FastifyRequest) {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    requestIsHttps(request) ? "Secure" : "",
    "Max-Age=0"
  ].filter(Boolean).join("; ");
}

function requestIsHttps(request: FastifyRequest) {
  const forwardedProto = stringHeader(request.headers["x-forwarded-proto"]);
  return request.protocol === "https" ||
    (isLoopbackAddress(request.raw.socket.remoteAddress ?? "") && forwardedProto?.split(",", 1)[0]?.trim() === "https");
}

function cookieValue(header: string | undefined, name: string) {
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function bearerToken(header: string | undefined) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function stringHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? undefined : value?.trim();
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function stripBrackets(value: string) {
  return value.replace(/^\[|\]$/g, "");
}

function validIpv4Part(value: string) {
  if (!/^\d{1,3}$/.test(value)) return false;
  const number = Number(value);
  return number >= 0 && number <= 255;
}

function constantTimeEqual(left: string, right: string) {
  return constantTimeEqualBytes(
    crypto.createHash("sha256").update(left, "utf8").digest(),
    crypto.createHash("sha256").update(right, "utf8").digest()
  );
}

function constantTimeEqualBytes(left: Buffer, right: Buffer) {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sessionTokenHash(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest("base64url");
}

async function writeCredentialRecord(filePath: string, record: AdminCredentialRecord) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function derivePassword(password: string, salt: string, keyLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function unauthorized(message = "管理员会话无效或已过期。") {
  return new AdminApiError(401, "ADMIN_UNAUTHORIZED", message);
}
