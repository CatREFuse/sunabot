import { readonly, shallowRef } from "vue";
import type { ApiErrorBody } from "../types";
import { agentScopedPath } from "./agentScope";

export interface AdminSession {
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
  expiresAt?: string;
}

const authorizationRequired = shallowRef(true);
const initialized = shallowRef(false);
const lastError = shallowRef("");
const username = shallowRef("");
let csrfToken = "";
let initialization: Promise<AdminSession> | undefined;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly latestRevision?: string;

  constructor(message: string, options: { status: number; code: string; field?: string; latestRevision?: string }) {
    super(message);
    this.name = "ApiRequestError";
    this.status = options.status;
    this.code = options.code;
    this.field = options.field;
    this.latestRevision = options.latestRevision;
  }
}

export async function initializeAdminSession() {
  if (!initialization) {
    initialization = fetch("/api/auth/session", {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    }).then(async (response) => {
      if (!response.ok) throw await responseError(response);
      return applySession(await response.json() as AdminSession);
    }).catch((error) => {
      applySession({ authenticated: false });
      throw error;
    }).finally(() => {
      initialized.value = true;
    });
  }
  return initialization;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(scopedApiPath(path), init);
}

export async function apiRequestUnscoped<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!isSafeMethod(init.method) && !csrfToken) await initializeAdminSession();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body != null && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (!isSafeMethod(init.method) && csrfToken) headers.set("x-sunabot-csrf", csrfToken);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : "无法连接 Sunabot";
    lastError.value = message;
    throw new ApiRequestError(message, { status: 0, code: "NETWORK_ERROR" });
  }

  if (!response.ok) {
    const error = await responseError(response);
    if (response.status === 401 || error.code === "ADMIN_SETUP_REQUIRED") {
      initialization = undefined;
      applySession({ authenticated: false });
    }
    lastError.value = error.message;
    throw error;
  }

  lastError.value = "";
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  path = scopedApiPath(path);
  const headers = new Headers(init.headers);
  if (!isSafeMethod(init.method) && csrfToken) headers.set("x-sunabot-csrf", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const error = await responseError(response);
    if (response.status === 401) applySession({ authenticated: false });
    throw error;
  }
  return response.blob();
}

const agentScopedPrefixes = [
  "/api/web-chat",
  "/api/conversations",
  "/api/memory",
  "/api/images",
  "/api/request-logs",
  "/api/token-usage",
  "/api/model-call-stats",
  "/api/playground/image",
  "/api/agent-files",
  "/api/tools",
  "/api/config",
  "/api/status",
  "/api/emojis",
  "/api/selfie-references"
];

function scopedApiPath(path: string) {
  const pathname = path.split("?", 1)[0] ?? path;
  return agentScopedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? agentScopedPath(path)
    : path;
}

export function authenticatedMediaPath(source: string) {
  if (
    source.startsWith("data:")
    || source.startsWith("blob:")
    || source.startsWith("/api/")
    || source.startsWith("/generated-images/")
  ) return source;
  return `/api/media/image?url=${encodeURIComponent(source)}`;
}

export function authenticatedThumbnailPath(source: string, variant: "display" | "placeholder" = "display") {
  if (source.startsWith("data:") || source.startsWith("blob:")) return source;
  return `/api/media/thumbnail?url=${encodeURIComponent(source)}&variant=${variant}`;
}

async function login(usernameValue: string, password: string) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ username: usernameValue, password })
  });
  if (!response.ok) throw await responseError(response);
  return applySession(await response.json() as AdminSession);
}

async function logout() {
  await apiRequest<void>("/api/auth/logout", { method: "POST" });
  initialization = undefined;
  applySession({ authenticated: false });
}

async function changePassword(input: { currentPassword: string; newPassword: string; confirmPassword: string }) {
  const session = await apiRequest<AdminSession>("/api/auth/password", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return applySession(session);
}

function applySession(session: AdminSession) {
  authorizationRequired.value = !session.authenticated;
  username.value = session.username ?? "";
  csrfToken = session.csrfToken ?? "";
  return session;
}

async function responseError(response: Response) {
  const body = await parseError(response);
  return new ApiRequestError(body.error.message, {
    status: response.status,
    code: body.error.code,
    field: body.error.field,
    latestRevision: body.error.latestRevision
  });
}

async function parseError(response: Response): Promise<ApiErrorBody> {
  try {
    const value = (await response.json()) as Partial<ApiErrorBody>;
    if (value.error?.message && value.error.code) return value as ApiErrorBody;
  } catch {
    // The fallback below is safe for non-JSON upstream failures.
  }
  return { error: { code: `HTTP_${response.status}`, message: response.statusText || "请求失败" } };
}

function isSafeMethod(method: string | undefined) {
  const value = (method ?? "GET").toUpperCase();
  return value === "GET" || value === "HEAD" || value === "OPTIONS";
}

export function useAdminApi() {
  function clearAuthorizationError() {
    authorizationRequired.value = false;
    lastError.value = "";
  }

  return {
    authorizationRequired: readonly(authorizationRequired),
    initialized: readonly(initialized),
    username: readonly(username),
    lastError: readonly(lastError),
    initialize: initializeAdminSession,
    login,
    logout,
    changePassword,
    clearAuthorizationError,
    request: apiRequest,
    blob: apiBlob
  };
}
