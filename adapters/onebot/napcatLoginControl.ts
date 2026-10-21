import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_WATCH_INTERVAL_MS = 2_000;
const LOGIN_WATCH_LIMIT_MS = 10 * 60_000;
const MAX_QR_BYTES = 1024 * 1024;
const QR_DISPLAY_WINDOW_MS = 60_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface NapcatWebUiConfig {
  port?: number;
  token?: string;
}

interface NapcatEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface NapcatRawLoginStatus {
  isLogin?: boolean;
  qrcodeurl?: string;
  loginError?: string;
}

interface NapcatRawLoginInfo {
  uin?: string | number;
  nick?: string;
  online?: boolean;
}

interface ManualLoginState {
  exists: boolean;
  offlineObserved: boolean;
}

export interface NapcatLoginSnapshot {
  isLogin: boolean;
  online?: boolean;
  manualLogin: boolean;
  qrcodeUrl?: string;
  loginError?: string;
  error?: string;
  data?: {
    user_id?: number;
    nickname?: string;
  };
  imageDataUrl?: string;
  imageUpdatedAt?: string;
  imageExpiresAt?: string;
}

export interface NapcatLoginControlPort {
  status(): Promise<NapcatLoginSnapshot>;
  refreshQrCode(): Promise<NapcatLoginSnapshot>;
  beginManualLogin(): Promise<void>;
  cancelManualLogin(): Promise<void>;
  startLoginCompletionWatch(): void;
  close(): void;
}

export interface NapcatLoginControlOptions {
  webuiConfigPath: string;
  webuiBaseUrl?: string;
  qrCodePath: string;
  manualLoginMarkerPath: string;
  runtimeEnvPath: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  watchIntervalMs?: number;
  loginFiles?: {
    read(name: string): Promise<{ data: Buffer; mtimeMs: number } | undefined>;
    write(name: string, data: string): Promise<void>;
    remove(name: string): Promise<void>;
  };
}

export class NapcatLoginControl implements NapcatLoginControlPort {
  private credential = "";
  private refreshRequest?: Promise<NapcatLoginSnapshot>;
  private statusRequest?: { generation: number; promise: Promise<NapcatLoginSnapshot> };
  private loginGeneration = 0;
  private loginMutation: Promise<void> = Promise.resolve();
  private finalizedUserId?: number;
  private watchTimer?: NodeJS.Timeout;
  private watchStartedAt = 0;
  private manualLoginObservedOffline = false;
  private closed = false;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly watchIntervalMs: number;
  private readonly webuiBaseUrl?: string;

  constructor(private readonly options: NapcatLoginControlOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.webuiBaseUrl = normalizeWebUiBaseUrl(options.webuiBaseUrl);
  }

  async status(): Promise<NapcatLoginSnapshot> {
    const generation = this.loginGeneration;
    if (this.statusRequest?.generation === generation) return this.statusRequest.promise;
    const promise = this.readStatus(generation).then((snapshot) =>
      generation === this.loginGeneration ? snapshot : this.status()
    ).finally(() => {
      if (this.statusRequest?.promise === promise) this.statusRequest = undefined;
    });
    this.statusRequest = { generation, promise };
    return promise;
  }

  private async readStatus(generation: number): Promise<NapcatLoginSnapshot> {
    await this.loginMutation;
    const manualLoginState = await this.readManualLoginState();
    const manualLogin = manualLoginState.exists;
    if (manualLoginState.offlineObserved && generation === this.loginGeneration) this.manualLoginObservedOffline = true;
    let source: NapcatRawLoginStatus;
    try {
      source = await this.request<NapcatRawLoginStatus>("/QQLogin/CheckLoginStatus");
    } catch (error) {
      return {
        isLogin: false,
        manualLogin,
        error: error instanceof Error ? error.message : "NapCat WebUI 暂不可用。"
      };
    }
    const isLogin = source.isLogin === true;
    const loginError = cleanText(source.loginError);
    if ((!isLogin || loginError) && generation === this.loginGeneration) this.finalizedUserId = undefined;
    if (manualLogin && !isLogin && !this.manualLoginObservedOffline && generation === this.loginGeneration) {
      await this.mutateLogin(async () => {
        if (generation !== this.loginGeneration || this.closed) return;
        await this.markManualLoginOffline();
        if (generation === this.loginGeneration) this.manualLoginObservedOffline = true;
      });
    }
    if (isLogin) {
      let loginInfo: NapcatRawLoginInfo;
      try {
        loginInfo = await this.request<NapcatRawLoginInfo>("/QQLogin/GetQQLoginInfo");
      } catch (error) {
        return { isLogin: true, manualLogin, loginError, error: error instanceof Error ? error.message : "QQ 在线状态读取失败。" };
      }
      const userId = normalizeQq(loginInfo.uin);
      const canFinalize = loginInfo.online === true && !loginError && (!manualLogin || this.manualLoginObservedOffline);
      if (loginInfo.online !== true && generation === this.loginGeneration) this.finalizedUserId = undefined;
      if (userId && canFinalize) await this.mutateLogin(async () => {
        if (generation !== this.loginGeneration || this.closed || (!manualLogin && this.finalizedUserId === userId)) return;
        await this.finalizeLogin(userId);
        if (generation === this.loginGeneration) this.finalizedUserId = userId;
      });
      return {
        isLogin: true,
        online: loginInfo.online,
        ...(loginError ? { loginError } : {}),
        ...(typeof loginInfo.online !== "boolean" ? { error: "QQ 在线状态未返回。" } : {}),
        manualLogin: userId && canFinalize ? false : manualLogin,
        data: {
          user_id: userId,
          nickname: cleanText(loginInfo.nick)
        }
      };
    }

    return {
      isLogin: false,
      manualLogin,
      qrcodeUrl: cleanText(source.qrcodeurl),
      loginError: cleanText(source.loginError),
      ...await this.readQrImage(),
      ...(loginError ? { loginError, imageDataUrl: undefined } : {})
    };
  }

  refreshQrCode(): Promise<NapcatLoginSnapshot> {
    this.refreshRequest ??= this.refresh().finally(() => { this.refreshRequest = undefined; });
    return this.refreshRequest;
  }

  private async refresh(): Promise<NapcatLoginSnapshot> {
    const current = await this.status();
    if (current.isLogin) return current;

    const previousImage = (await this.readLoginFile("qrcode.png", this.options.qrCodePath))?.data;
    await this.request("/QQLogin/RefreshQRcode");
    await this.waitForQrChange(previousImage);
    const refreshed = await this.status();
    if (!refreshed.isLogin && !refreshed.imageDataUrl) {
      throw new ServiceError(502, "QQ_QR_REFRESH_FAILED", "未获取到有效二维码，请点击刷新重试。");
    }
    return refreshed;
  }

  beginManualLogin() {
    this.loginGeneration += 1;
    this.finalizedUserId = undefined;
    this.manualLoginObservedOffline = false;
    return this.mutateLogin(async () => {
      await this.writeLoginFile("manual-login-required", this.options.manualLoginMarkerPath,
        `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);
      await this.removeLoginFile("qrcode.png", this.options.qrCodePath);
      try {
        await this.request("/QQLogin/SetQuickLoginQQ", { uin: "" });
      } catch (error) {
        await this.removeLoginFile("manual-login-required", this.options.manualLoginMarkerPath);
        throw error;
      }
    });
  }

  cancelManualLogin() {
    this.loginGeneration += 1;
    this.finalizedUserId = undefined;
    this.manualLoginObservedOffline = false;
    return this.mutateLogin(async () => {
      const account = await this.readRuntimeEnvAccount();
      if (account) await this.request("/QQLogin/SetQuickLoginQQ", { uin: account });
      await this.removeLoginFile("manual-login-required", this.options.manualLoginMarkerPath);
    });
  }

  private mutateLogin(operation: () => Promise<void>): Promise<void> {
    const result = this.loginMutation.then(operation);
    // Keep later transitions runnable; the original rejection is returned to its caller.
    this.loginMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  startLoginCompletionWatch() {
    this.stopLoginCompletionWatch();
    this.watchStartedAt = Date.now();
    this.scheduleLoginWatch(1_000);
  }

  close() {
    this.closed = true;
    this.loginGeneration += 1;
    this.stopLoginCompletionWatch();
  }

  private scheduleLoginWatch(delayMs: number) {
    if (this.closed) return;
    this.watchTimer = setTimeout(() => void this.pollLoginCompletion(), delayMs);
    this.watchTimer.unref?.();
  }

  private async pollLoginCompletion() {
    this.watchTimer = undefined;
    if (this.closed || Date.now() - this.watchStartedAt > LOGIN_WATCH_LIMIT_MS) return;
    try {
      const snapshot = await this.status();
      if (snapshot.online === true && !snapshot.manualLogin && !snapshot.loginError && snapshot.data?.user_id) return;
    } catch {
      // NapCat restarts briefly after bot_exit; polling resumes until WebUI is ready.
    }
    this.scheduleLoginWatch(this.watchIntervalMs);
  }

  private stopLoginCompletionWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
  }

  private async finalizeLogin(userId?: number) {
    if (!userId) return;
    await this.request("/QQLogin/SetQuickLoginQQ", { uin: String(userId) });
    await this.persistNapcatAccount(userId);
    await Promise.all([
      this.removeLoginFile("manual-login-required", this.options.manualLoginMarkerPath),
      this.removeLoginFile("qrcode.png", this.options.qrCodePath)
    ]);
    this.stopLoginCompletionWatch();
    this.manualLoginObservedOffline = false;
  }

  private async persistNapcatAccount(userId: number) {
    const source = (await this.readLoginFile("account.env", this.options.runtimeEnvPath))?.data.toString("utf8") ?? "";
    const next = setUniqueEnvValue(source, "NAPCAT_ACCOUNT", String(userId));
    if (next === source) return;
    await this.writeLoginFile("account.env", this.options.runtimeEnvPath, next);
  }

  private async readRuntimeEnvAccount() {
    const source = (await this.readLoginFile("account.env", this.options.runtimeEnvPath))?.data.toString("utf8") ?? "";
    const match = source.match(/^[ \t]*(?:export[ \t]+)?NAPCAT_ACCOUNT[ \t]*=[ \t]*(\d{5,12})[ \t]*$/m);
    return match?.[1] ?? "";
  }

  private async readQrImage() {
    if (this.options.loginFiles) {
      const file = await this.options.loginFiles.read("qrcode.png");
      if (!file || file.data.length === 0 || file.data.length > MAX_QR_BYTES || !isPng(file.data)) return {};
      const imageUpdatedAt = new Date(file.mtimeMs).toISOString();
      const imageExpiresAt = new Date(file.mtimeMs + QR_DISPLAY_WINDOW_MS).toISOString();
      if (Date.now() >= file.mtimeMs + QR_DISPLAY_WINDOW_MS || file.mtimeMs > Date.now()) {
        return { imageUpdatedAt, imageExpiresAt, loginError: "二维码已过期，请点击刷新。" };
      }
      return { imageDataUrl: `data:image/png;base64,${file.data.toString("base64")}`, imageUpdatedAt, imageExpiresAt };
    }
    const stats = await fs.stat(this.options.qrCodePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats?.isFile() || stats.size <= 0 || stats.size > MAX_QR_BYTES) return {};
    const imageExpiresAt = new Date(stats.mtimeMs + QR_DISPLAY_WINDOW_MS).toISOString();
    if (Date.now() >= stats.mtimeMs + QR_DISPLAY_WINDOW_MS || stats.mtimeMs > Date.now()) {
      return { imageUpdatedAt: stats.mtime.toISOString(), imageExpiresAt, loginError: "二维码已过期，请点击刷新。" };
    }
    const image = await fs.readFile(this.options.qrCodePath);
    if (!isPng(image)) return {};
    return {
      imageDataUrl: `data:image/png;base64,${image.toString("base64")}`,
      imageUpdatedAt: stats.mtime.toISOString(),
      imageExpiresAt
    };
  }

  private async readManualLoginState(): Promise<ManualLoginState> {
    const source = (await this.readLoginFile("manual-login-required", this.options.manualLoginMarkerPath))?.data.toString("utf8");
    if (source === undefined) return { exists: false, offlineObserved: false };
    try {
      const value = JSON.parse(source) as { offlineObservedAt?: unknown };
      return { exists: true, offlineObserved: typeof value.offlineObservedAt === "string" };
    } catch {
      return { exists: true, offlineObserved: false };
    }
  }

  private async markManualLoginOffline() {
    const source = (await this.readLoginFile("manual-login-required", this.options.manualLoginMarkerPath))?.data.toString("utf8");
    if (source === undefined) throw new Error("手动登录标记已丢失。");
    let value: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(source) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve the marker when an older version wrote malformed content.
    }
    if (typeof value.offlineObservedAt === "string") return;
    await this.writeLoginFile("manual-login-required", this.options.manualLoginMarkerPath, `${JSON.stringify({
      ...value,
      offlineObservedAt: new Date().toISOString()
    })}\n`);
  }

  private async readLoginFile(name: string, localPath: string) {
    if (this.options.loginFiles) return this.options.loginFiles.read(name);
    try {
      const data = await fs.readFile(localPath);
      return { data, mtimeMs: (await fs.stat(localPath)).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeLoginFile(name: string, localPath: string, data: string) {
    if (this.options.loginFiles) return this.options.loginFiles.write(name, data);
    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const temporary = `${localPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, localPath);
  }

  private async removeLoginFile(name: string, localPath: string) {
    if (this.options.loginFiles) return this.options.loginFiles.remove(name);
    await fs.rm(localPath, { force: true });
  }

  private async waitForQrChange(previousImage?: Buffer) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const next = await this.readQrImage();
      if (next.imageDataUrl && next.imageDataUrl !== (previousImage ? `data:image/png;base64,${previousImage.toString("base64")}` : undefined)) return;
    }
    throw new ServiceError(504, "QQ_QR_REFRESH_TIMEOUT", "二维码刷新失败：NapCat 未生成新二维码，请点击刷新重试。");
  }

  private async request<T = unknown>(pathname: string, body: unknown = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.credential) this.credential = await this.authenticate();
      const result = await this.fetchJson<T>(pathname, this.credential, body);
      if (result.code === 0) return result.data as T;
      const message = cleanText(result.message) || "NapCat WebUI 请求失败。";
      if (attempt === 0 && /unauthorized|revoked|authorization/i.test(message)) {
        this.credential = "";
        continue;
      }
      throw new Error(message);
    }
    throw new Error("NapCat WebUI 认证失败。");
  }

  private async authenticate() {
    const config = await this.readWebUiConfig();
    const hash = crypto.createHash("sha256").update(`${config.token}.napcat`).digest("hex");
    const response = await this.fetchJson<{ Credential?: string }>("/auth/login", "", { hash }, config.port);
    const credential = cleanText(response.data?.Credential);
    if (response.code !== 0 || !credential) throw new Error(cleanText(response.message) || "NapCat WebUI 认证失败。");
    return credential;
  }

  private async fetchJson<T>(pathname: string, credential = "", body: unknown = {}, explicitPort?: number) {
    const config = explicitPort ? { port: explicitPort } : await this.readWebUiConfig();
    const baseUrl = this.webuiBaseUrl ?? `http://127.0.0.1:${config.port}`;
    const response = await this.fetchImpl(`${baseUrl}/api${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`NapCat WebUI 返回 HTTP ${response.status}。`);
    return await response.json() as NapcatEnvelope<T>;
  }

  private async readWebUiConfig() {
    const source = JSON.parse(await fs.readFile(this.options.webuiConfigPath, "utf8")) as NapcatWebUiConfig;
    const port = Number(source.port ?? 6099);
    const token = cleanText(source.token);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
      throw new Error("NapCat WebUI 配置无效。");
    }
    return { port, token };
  }
}

function normalizeWebUiBaseUrl(value: string | undefined) {
  const source = value?.trim();
  if (!source) return undefined;
  const url = new URL(source);
  if (url.protocol !== "http:" || !(
    ["127.0.0.1", "localhost", "napcat"].includes(url.hostname) || /^napcat-[a-z0-9_-]{1,64}$/i.test(url.hostname)
  )) {
    throw new Error("NapCat WebUI 地址无效。");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("NapCat WebUI 地址无效。");
  }
  return url.origin;
}

function setUniqueEnvValue(source: string, key: string, value: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=.*$`, "gm");
  const matches = source.match(expression) ?? [];
  if (matches.length > 1) throw new Error(`runtime.env contains duplicate ${key} assignments.`);
  const assignment = `${key}=${value}`;
  if (matches.length === 1) return source.replace(expression, assignment);
  const prefix = source && !source.endsWith("\n") ? `${source}\n` : source;
  return `${prefix}${assignment}\n`;
}

function normalizeQq(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d{5,12}$/.test(text) ? Number(text) : undefined;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function isPng(value: Buffer) {
  return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
