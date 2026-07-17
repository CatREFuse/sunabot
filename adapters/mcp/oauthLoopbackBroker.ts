import { randomInt } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";

export const MCP_OAUTH_LOOPBACK_CALLBACK_PATH = "/oauth/callback";

const LOOPBACK_HOST = "127.0.0.1";
const MIN_EPHEMERAL_PORT = 49_152;
const MAX_EPHEMERAL_PORT = 65_535;
const MAX_PORT_ATTEMPTS = 32;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 30_000;
const MAX_ACTIVATION_TIMEOUT_MS = 60_000;
const MAX_ACTIVE_LIFETIME_MS = 15 * 60_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 60_000;
const MAX_CALLBACK_TIMEOUT_MS = 120_000;
const MAX_REQUESTS = 32;
const MAX_CONNECTIONS = 16;
const MAX_URL_BYTES = 2_048;
const MAX_HEADER_BYTES = 8 * 1_024;
const MAX_HEADER_PAIRS = 32;
const MAX_STATE_BYTES = 1_024;
const MAX_CODE_BYTES = 8 * 1_024;
const SOCKET_TIMEOUT_MS = MAX_CALLBACK_TIMEOUT_MS + 5_000;

const SUCCESS_HTML = htmlPage("授权完成", "可以关闭此页面，返回 Sunabot。");
const FAILURE_HTML = htmlPage("授权未完成", "请返回 Sunabot 重试。");

export interface McpOAuthLoopbackCallbackInput {
  state: string;
  code: string;
  signal: AbortSignal;
}

export interface McpOAuthLoopbackActivation {
  readonly state: string;
  readonly expiresAt: number;
  readonly signal?: AbortSignal;
  onCallback(input: McpOAuthLoopbackCallbackInput): Promise<void> | void;
}

export interface McpOAuthLoopbackReservation {
  redirectUri: string;
  activate(input: McpOAuthLoopbackActivation): void;
  close(): Promise<void>;
}

export interface McpOAuthLoopbackReserveInput {
  signal?: AbortSignal;
}

export interface McpOAuthLoopbackBrokerOptions {
  now?: () => number;
  portCandidate?: () => number;
  activationTimeoutMs?: number;
  callbackTimeoutMs?: number;
}

export class McpOAuthLoopbackBroker {
  private readonly now: () => number;
  private readonly portCandidate: () => number;
  private readonly activationTimeoutMs: number;
  private readonly callbackTimeoutMs: number;

  constructor(options: McpOAuthLoopbackBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.portCandidate = options.portCandidate ?? (() => randomInt(MIN_EPHEMERAL_PORT, MAX_EPHEMERAL_PORT + 1));
    this.activationTimeoutMs = boundedDuration(
      options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
      MAX_ACTIVATION_TIMEOUT_MS
    );
    this.callbackTimeoutMs = boundedDuration(
      options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      MAX_CALLBACK_TIMEOUT_MS
    );
  }

  async reserve(input: McpOAuthLoopbackReserveInput = {}): Promise<McpOAuthLoopbackReservation> {
    if (input.signal?.aborted) throw stableError("MCP_OAUTH_LOOPBACK_ABORTED");
    const reservation = new ReservedLoopback({
      now: this.now,
      portCandidate: this.portCandidate,
      activationTimeoutMs: this.activationTimeoutMs,
      callbackTimeoutMs: this.callbackTimeoutMs,
      signal: input.signal
    });
    await reservation.listen();
    return reservation.publicReservation();
  }
}

class ReservedLoopback {
  private server?: Server;
  private port?: number;
  private activated = false;
  private consumed = false;
  private closed = false;
  private requestCount = 0;
  private reservationExpiresAt?: number;
  private activation?: Readonly<Pick<McpOAuthLoopbackActivation, "state" | "expiresAt" | "onCallback">>;
  private activationTimer?: NodeJS.Timeout;
  private callbackTimer?: NodeJS.Timeout;
  private serverClosePromise?: Promise<void>;
  private readonly controller = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly externalAbortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];

  constructor(private readonly options: {
    now: () => number;
    portCandidate: () => number;
    activationTimeoutMs: number;
    callbackTimeoutMs: number;
    signal?: AbortSignal;
  }) {}

  async listen() {
    const attempted = new Set<number>();
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
      const port = validPortCandidate(this.options.portCandidate());
      if (attempted.has(port)) continue;
      attempted.add(port);
      const server = this.createBoundedServer(port);
      try {
        await listen(server, port);
      } catch (error) {
        await closeFailedServer(server);
        if (!isAddressInUse(error)) throw stableError("MCP_OAUTH_LOOPBACK_LISTEN_FAILED");
        continue;
      }
      this.server = server;
      this.port = port;
      if (this.options.signal?.aborted) {
        await this.terminate(true);
        throw stableError("MCP_OAUTH_LOOPBACK_ABORTED");
      }
      this.attachExternalAbort(this.options.signal);
      if (this.options.signal?.aborted) {
        await this.terminate(true);
        throw stableError("MCP_OAUTH_LOOPBACK_ABORTED");
      }
      this.reservationExpiresAt = this.options.now() + this.options.activationTimeoutMs;
      this.activationTimer = boundedTimer(() => {
        void this.terminate(true);
      }, this.reservationExpiresAt - this.options.now());
      return;
    }
    throw stableError("MCP_OAUTH_LOOPBACK_LISTEN_FAILED");
  }

  publicReservation(): McpOAuthLoopbackReservation {
    const port = this.port;
    if (!port || !this.server) throw stableError("MCP_OAUTH_LOOPBACK_LISTEN_FAILED");
    return {
      redirectUri: `http://${LOOPBACK_HOST}:${port}${MCP_OAUTH_LOOPBACK_CALLBACK_PATH}`,
      activate: (input) => this.activate(input),
      close: () => this.terminate(true)
    };
  }

  private activate(input: McpOAuthLoopbackActivation) {
    if (this.closed) throw stableError("MCP_OAUTH_LOOPBACK_CLOSED");
    if (this.activated) throw stableError("MCP_OAUTH_LOOPBACK_ALREADY_ACTIVATED");
    const now = this.options.now();
    if (!validState(input.state)
      || this.reservationExpiresAt === undefined
      || this.reservationExpiresAt <= now
      || !Number.isSafeInteger(input.expiresAt)
      || input.expiresAt <= now
      || input.expiresAt > now + MAX_ACTIVE_LIFETIME_MS
      || typeof input.onCallback !== "function"
      || input.signal?.aborted) {
      void this.terminate(true);
      throw stableError(input.signal?.aborted
        ? "MCP_OAUTH_LOOPBACK_ABORTED"
        : "MCP_OAUTH_LOOPBACK_ACTIVATION_INVALID");
    }
    this.activated = true;
    this.activation = {
      state: input.state,
      expiresAt: input.expiresAt,
      onCallback: input.onCallback
    };
    clearTimer(this.activationTimer);
    this.activationTimer = boundedTimer(() => {
      void this.terminate(true);
    }, input.expiresAt - now);
    this.attachExternalAbort(input.signal);
    if (input.signal?.aborted) {
      void this.terminate(true);
      throw stableError("MCP_OAUTH_LOOPBACK_ABORTED");
    }
  }

  private createBoundedServer(port: number) {
    const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
      void this.handleRequest(port, request, response).catch(() => {
        safeDestroy(response);
        void this.terminate(true);
      });
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 500;
    server.maxRequestsPerSocket = 1;
    server.maxConnections = MAX_CONNECTIONS;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      if (socket.writable) {
        socket.end(rawFailureResponse());
      } else {
        socket.destroy();
      }
    });
    server.on("error", () => {
      if (server === this.server) void this.terminate(true);
    });
    return server;
  }

  private async handleRequest(port: number, request: IncomingMessage, response: ServerResponse) {
    this.requestCount += 1;
    const now = this.options.now();
    const expired = this.activated
      ? this.activation === undefined || this.activation.expiresAt <= now
      : this.reservationExpiresAt === undefined || this.reservationExpiresAt <= now;
    if (expired) {
      await sendHtml(response, 400, FAILURE_HTML);
      await this.terminate(false);
      return;
    }
    if (this.closed || this.consumed || !validRequestEnvelope(request, port)) {
      await sendHtml(response, 400, FAILURE_HTML);
      if (this.requestCount >= MAX_REQUESTS) await this.terminate(false);
      return;
    }
    const parameters = exactCallbackParameters(request.url ?? "");
    if (!parameters || !this.activated || !this.activation || parameters.state !== this.activation.state) {
      await sendHtml(response, 400, FAILURE_HTML);
      if (this.requestCount >= MAX_REQUESTS) await this.terminate(false);
      return;
    }
    if (!validAuthorizationCode(parameters.code)) {
      await sendHtml(response, 400, FAILURE_HTML);
      if (this.requestCount >= MAX_REQUESTS) await this.terminate(false);
      return;
    }

    this.consumed = true;
    void this.stopServer(false);
    const callbackDeadline = Math.min(
      this.activation.expiresAt,
      this.options.now() + this.options.callbackTimeoutMs
    );
    clearTimer(this.activationTimer);
    this.callbackTimer = boundedTimer(() => this.controller.abort(), Math.max(1, callbackDeadline - this.options.now()));
    let succeeded = false;
    try {
      await runCallback(this.activation.onCallback, {
        state: parameters.state,
        code: parameters.code,
        signal: this.controller.signal
      });
      succeeded = !this.controller.signal.aborted && this.options.now() < callbackDeadline;
    } catch {
      succeeded = false;
    } finally {
      clearTimer(this.callbackTimer);
    }
    await sendHtml(response, succeeded ? 200 : 400, succeeded ? SUCCESS_HTML : FAILURE_HTML);
    await this.terminate(false);
  }

  private attachExternalAbort(signal: AbortSignal | undefined) {
    if (!signal) return;
    const listener = () => {
      void this.terminate(true);
    };
    this.externalAbortListeners.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  }

  private async terminate(force: boolean) {
    if (!this.closed) {
      this.closed = true;
      clearTimer(this.activationTimer);
      clearTimer(this.callbackTimer);
      for (const entry of this.externalAbortListeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
      this.externalAbortListeners.length = 0;
      if (force && !this.controller.signal.aborted) this.controller.abort();
    }
    await this.stopServer(force);
  }

  private stopServer(force: boolean) {
    const server = this.server;
    if (!server) return Promise.resolve();
    if (!this.serverClosePromise) {
      this.serverClosePromise = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
    if (force) {
      for (const socket of this.sockets) socket.destroy();
      server.closeAllConnections();
    }
    return this.serverClosePromise;
  }
}

function validRequestEnvelope(request: IncomingMessage, port: number) {
  const rawUrl = request.url ?? "";
  if (request.method !== "GET"
    || request.socket.remoteAddress !== LOOPBACK_HOST
    || Buffer.byteLength(rawUrl) > MAX_URL_BYTES
    || !rawUrl.startsWith(`${MCP_OAUTH_LOOPBACK_CALLBACK_PATH}?`)
    || rawUrl.includes("#")
    || request.headers["content-length"] !== undefined
    || request.headers["transfer-encoding"] !== undefined
    || request.rawHeaders.length > MAX_HEADER_PAIRS * 2
    || rawHeaderBytes(request.rawHeaders) > MAX_HEADER_BYTES) {
    return false;
  }
  const hostValues: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      hostValues.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return hostValues.length === 1 && hostValues[0] === `${LOOPBACK_HOST}:${port}`;
}

function exactCallbackParameters(rawUrl: string) {
  const query = rawUrl.slice(MCP_OAUTH_LOOPBACK_CALLBACK_PATH.length + 1);
  const rawParameters = query.split("&");
  if (rawParameters.length !== 2
    || rawParameters.some((parameter) => parameter.length === 0 || !parameter.includes("="))) {
    return undefined;
  }
  const rawKeys = rawParameters
    .map((parameter) => parameter.slice(0, parameter.indexOf("=")))
    .sort();
  if (rawKeys[0] !== "code" || rawKeys[1] !== "state") return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${LOOPBACK_HOST}`);
  } catch {
    return undefined;
  }
  if (url.origin !== `http://${LOOPBACK_HOST}` || url.pathname !== MCP_OAUTH_LOOPBACK_CALLBACK_PATH) {
    return undefined;
  }
  const entries = Array.from(url.searchParams.entries());
  if (entries.length !== 2) return undefined;
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  if (states.length !== 1 || codes.length !== 1) return undefined;
  return { state: states[0] ?? "", code: codes[0] ?? "" };
}

function validState(value: string) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value) <= MAX_STATE_BYTES;
}

function validAuthorizationCode(value: string) {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= MAX_CODE_BYTES;
}

function rawHeaderBytes(rawHeaders: string[]) {
  return rawHeaders.reduce((total, value) => total + Buffer.byteLength(value) + 2, 0);
}

async function runCallback(
  callback: McpOAuthLoopbackActivation["onCallback"],
  input: McpOAuthLoopbackCallbackInput
) {
  if (input.signal.aborted) throw stableError("MCP_OAUTH_LOOPBACK_ABORTED");
  let abortListener!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(stableError("MCP_OAUTH_LOOPBACK_ABORTED"));
    input.signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => callback(input)), aborted]);
  } finally {
    input.signal.removeEventListener("abort", abortListener);
  }
}

function sendHtml(response: ServerResponse, statusCode: number, body: string) {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Connection", "close");
  return new Promise<void>((resolve) => {
    const complete = () => {
      response.off("close", complete);
      response.off("error", complete);
      resolve();
    };
    response.once("close", complete);
    response.once("error", complete);
    response.end(body, complete);
  });
}

function htmlPage(title: string, message: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function rawFailureResponse() {
  return [
    "HTTP/1.1 400 Bad Request",
    "Content-Type: text/html; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(FAILURE_HTML)}`,
    "Cache-Control: no-store, max-age=0",
    "Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy: no-referrer",
    "Permissions-Policy: camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Connection: close",
    "",
    FAILURE_HTML
  ].join("\r\n");
}

function boundedDuration(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 10 || value > maximum) {
    throw stableError("MCP_OAUTH_LOOPBACK_CONFIG_INVALID");
  }
  return value;
}

function validPortCandidate(value: number) {
  if (!Number.isSafeInteger(value) || value < MIN_EPHEMERAL_PORT || value > MAX_EPHEMERAL_PORT) {
    throw stableError("MCP_OAUTH_LOOPBACK_CONFIG_INVALID");
  }
  return value;
}

function boundedTimer(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, Math.max(1, delayMs));
  timer.unref();
  return timer;
}

function clearTimer(timer: NodeJS.Timeout | undefined) {
  if (timer) clearTimeout(timer);
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });
}

async function closeFailedServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isAddressInUse(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function safeDestroy(response: ServerResponse) {
  if (!response.destroyed) response.destroy();
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpOAuthLoopbackBrokerError";
  return error;
}
