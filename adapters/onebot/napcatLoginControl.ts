import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_WATCH_INTERVAL_MS = 2_000;
const LOGIN_WATCH_LIMIT_MS = 10 * 60_000;
const MAX_QR_BYTES = 1024 * 1024;

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
}

export class NapcatLoginControl implements NapcatLoginControlPort {
  private credential = "";
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
    const [manualLoginState, qr] = await Promise.all([
      this.readManualLoginState(),
      this.readQrImage()
    ]);
    const manualLogin = manualLoginState.exists;
    if (manualLoginState.offlineObserved) this.manualLoginObservedOffline = true;
    let source: NapcatRawLoginStatus;
    try {
      source = await this.request<NapcatRawLoginStatus>("/QQLogin/CheckLoginStatus");
    } catch (error) {
      return {
        isLogin: false,
        manualLogin,
        error: error instanceof Error ? error.message : "NapCat WebUI 暂不可用。",
        ...qr
      };
    }
    const isLogin = source.isLogin === true;
    if (manualLogin && !isLogin && !this.manualLoginObservedOffline) {
      await this.markManualLoginOffline();
      this.manualLoginObservedOffline = true;
    }
    if (isLogin) {
      const loginInfo = await this.request<NapcatRawLoginInfo>("/QQLogin/GetQQLoginInfo")
        .catch((): NapcatRawLoginInfo => ({}));
      const userId = normalizeQq(loginInfo.uin);
      const canFinalize = !manualLogin || this.manualLoginObservedOffline;
      if (userId && canFinalize) await this.finalizeLogin(userId);
      return {
        isLogin: true,
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
      ...qr
    };
  }

  async refreshQrCode(): Promise<NapcatLoginSnapshot> {
    const current = await this.status();
    if (current.isLogin) return current;

    const previousMtime = await this.qrMtime();
    await this.request("/QQLogin/RefreshQRcode");
    await this.waitForQrChange(previousMtime);
    return this.status();
  }

  async beginManualLogin() {
    await fs.mkdir(path.dirname(this.options.manualLoginMarkerPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.manualLoginMarkerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.options.manualLoginMarkerPath);
    await fs.rm(this.options.qrCodePath, { force: true });
    this.manualLoginObservedOffline = false;
    try {
      await this.request("/QQLogin/SetQuickLoginQQ", { uin: "" });
    } catch (error) {
      await fs.rm(this.options.manualLoginMarkerPath, { force: true });
      throw error;
    }
  }

  async cancelManualLogin() {
    const account = await this.readRuntimeEnvAccount();
    if (account) await this.request("/QQLogin/SetQuickLoginQQ", { uin: account }).catch(() => undefined);
    await fs.rm(this.options.manualLoginMarkerPath, { force: true });
  }

  startLoginCompletionWatch() {
    this.stopLoginCompletionWatch();
    this.watchStartedAt = Date.now();
    this.scheduleLoginWatch(1_000);
  }

  close() {
    this.closed = true;
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
      if (snapshot.isLogin && snapshot.data?.user_id) return;
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
      fs.rm(this.options.manualLoginMarkerPath, { force: true }),
      fs.rm(this.options.qrCodePath, { force: true })
    ]);
    this.stopLoginCompletionWatch();
    this.manualLoginObservedOffline = false;
  }

  private async persistNapcatAccount(userId: number) {
    const source = await fs.readFile(this.options.runtimeEnvPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const next = setUniqueEnvValue(source, "NAPCAT_ACCOUNT", String(userId));
    if (next === source) return;
    await fs.mkdir(path.dirname(this.options.runtimeEnvPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.runtimeEnvPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, next, { mode: 0o600 });
    await fs.rename(temporary, this.options.runtimeEnvPath);
    await fs.chmod(this.options.runtimeEnvPath, 0o600).catch(() => undefined);
  }

  private async readRuntimeEnvAccount() {
    const source = await fs.readFile(this.options.runtimeEnvPath, "utf8").catch(() => "");
    const match = source.match(/^[ \t]*(?:export[ \t]+)?NAPCAT_ACCOUNT[ \t]*=[ \t]*(\d{5,12})[ \t]*$/m);
    return match?.[1] ?? "";
  }

  private async readQrImage() {
    const stats = await fs.stat(this.options.qrCodePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats?.isFile() || stats.size <= 0 || stats.size > MAX_QR_BYTES) return {};
    const image = await fs.readFile(this.options.qrCodePath);
    if (!isPng(image)) return {};
    return {
      imageDataUrl: `data:image/png;base64,${image.toString("base64")}`,
      imageUpdatedAt: stats.mtime.toISOString()
    };
  }

  private async readManualLoginState(): Promise<ManualLoginState> {
    const source = await fs.readFile(this.options.manualLoginMarkerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (source === undefined) return { exists: false, offlineObserved: false };
    try {
      const value = JSON.parse(source) as { offlineObservedAt?: unknown };
      return { exists: true, offlineObserved: typeof value.offlineObservedAt === "string" };
    } catch {
      return { exists: true, offlineObserved: false };
    }
  }

  private async markManualLoginOffline() {
    const source = await fs.readFile(this.options.manualLoginMarkerPath, "utf8");
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
    const temporary = `${this.options.manualLoginMarkerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      ...value,
      offlineObservedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.options.manualLoginMarkerPath);
  }

  private async qrMtime() {
    return (await fs.stat(this.options.qrCodePath).catch(() => undefined))?.mtimeMs ?? 0;
  }

  private async waitForQrChange(previousMtime: number) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(100);
      const nextMtime = await this.qrMtime();
      if (nextMtime > previousMtime) return;
    }
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
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "napcat"].includes(url.hostname)) {
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
