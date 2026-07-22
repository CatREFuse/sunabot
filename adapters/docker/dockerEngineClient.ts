import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_DOCKER_CONFIG_BYTES = 128 * 1_024;

export type DockerEngineFailureKind =
  | "aborted"
  | "configuration"
  | "response_too_large"
  | "socket"
  | "timeout";

export class DockerEngineClientError extends Error {
  constructor(readonly kind: DockerEngineFailureKind) {
    super(`Docker Engine request failed: ${kind}`);
    this.name = "DockerEngineClientError";
  }
}

export interface DockerEngineRequest {
  method: "DELETE" | "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface DockerEngineResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface DockerEngineClientPort {
  readonly endpointId: string;
  request(input: DockerEngineRequest): Promise<DockerEngineResponse>;
}

export interface DockerEngineClientOptions {
  environment?: Readonly<NodeJS.ProcessEnv>;
  socketPath?: string;
  request?: typeof http.request;
}

export async function createDockerEngineClient(
  options: DockerEngineClientOptions = {}
): Promise<DockerEngineClientPort> {
  const resolvedSocketPath = options.socketPath
    ? validateSocketPath(options.socketPath)
    : await resolveDockerSocketPath(options.environment ?? process.env);
  const socketPath = options.request
    ? resolvedSocketPath
    : await canonicalSocketPath(resolvedSocketPath);
  return new UnixSocketDockerEngineClient(socketPath, options.request ?? http.request);
}

class UnixSocketDockerEngineClient implements DockerEngineClientPort {
  readonly endpointId: string;
  private apiVersion?: string;
  private apiVersionFlight?: Promise<string>;

  constructor(
    private readonly socketPath: string,
    private readonly requestImpl: typeof http.request
  ) {
    this.endpointId = createHash("sha256").update(socketPath).digest("hex").slice(0, 32);
  }

  async request(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    const deadline = Date.now() + positiveInteger(input.timeoutMs, 1);
    if (isUnversionedPath(input.path)) {
      return this.rawRequest({ ...input, timeoutMs: remainingBudget(deadline) });
    }
    const apiVersion = await withDeadline(
      this.resolveApiVersion({ ...input, timeoutMs: remainingBudget(deadline) }),
      remainingBudget(deadline),
      input.signal
    );
    return this.rawRequest({
      ...input,
      path: `/v${apiVersion}${input.path}`,
      timeoutMs: remainingBudget(deadline)
    });
  }

  private resolveApiVersion(input: DockerEngineRequest) {
    if (this.apiVersion) return Promise.resolve(this.apiVersion);
    this.apiVersionFlight ??= this.rawRequest({
      method: "GET",
      path: "/version",
      timeoutMs: input.timeoutMs,
      maxResponseBytes: 64 * 1_024
    }).then((response) => {
      if (response.statusCode !== 200) throw new DockerEngineClientError("socket");
      const payload = parseJsonObject(response.body);
      const apiVersion = payload.ApiVersion;
      if (typeof apiVersion !== "string" || !/^1\.[0-9]{1,3}$/.test(apiVersion)) {
        throw new DockerEngineClientError("configuration");
      }
      this.apiVersion = apiVersion;
      return apiVersion;
    }).catch((error) => {
      throw error;
    }).finally(() => {
      this.apiVersionFlight = undefined;
    });
    return this.apiVersionFlight;
  }

  private rawRequest(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    const timeoutMs = positiveInteger(input.timeoutMs, 1);
    const maxResponseBytes = positiveInteger(input.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    return new Promise((resolve, reject) => {
      let request: http.ClientRequest | undefined;
      let response: http.IncomingMessage | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      let abortListener: (() => void) | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (abortListener && input.signal) input.signal.removeEventListener("abort", abortListener);
      };
      const fail = (kind: DockerEngineFailureKind) => {
        if (settled) return;
        settled = true;
        cleanup();
        response?.destroy();
        request?.destroy();
        reject(new DockerEngineClientError(kind));
      };
      if (input.signal?.aborted) {
        fail("aborted");
        return;
      }
      try {
        request = this.requestImpl({
          socketPath: this.socketPath,
          method: input.method,
          path: input.path,
          headers: body ? {
            "content-type": "application/json",
            "content-length": String(body.byteLength)
          } : undefined,
          agent: false
        }, (incoming) => {
          response = incoming;
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          incoming.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.byteLength;
            if (totalBytes > maxResponseBytes) {
              fail("response_too_large");
              return;
            }
            chunks.push(buffer);
          });
          incoming.on("error", () => fail("socket"));
          incoming.on("end", () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
              statusCode: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks, totalBytes)
            });
          });
        });
        request.on("error", () => fail(input.signal?.aborted ? "aborted" : "socket"));
        timer = setTimeout(() => fail("timeout"), timeoutMs);
        timer.unref();
        if (input.signal) {
          abortListener = () => fail("aborted");
          input.signal.addEventListener("abort", abortListener, { once: true });
        }
        request.end(body);
      } catch {
        fail("socket");
      }
    });
  }
}

async function resolveDockerSocketPath(environment: Readonly<NodeJS.ProcessEnv>) {
  const pinnedSocket = environment.SUNABOT_DOCKER_SOCKET?.trim();
  if (pinnedSocket) return validateSocketPath(pinnedSocket);

  const homeDirectory = environment.HOME?.trim() || os.homedir();
  const configuredDirectory = environment.DOCKER_CONFIG?.trim();
  const dockerConfigDirectory = configuredDirectory
    ? validateAbsolutePath(configuredDirectory)
    : path.join(homeDirectory, ".docker");
  const configuredContext = environment.DOCKER_CONTEXT?.trim();
  const explicitHost = environment.DOCKER_HOST?.trim();
  if (!configuredContext && explicitHost) return socketPathFromDockerHost(explicitHost);
  const config = configuredContext
    ? undefined
    : await readOptionalJson(path.join(dockerConfigDirectory, "config.json"));
  const currentContext = configuredContext
    || (typeof config?.currentContext === "string" ? config.currentContext.trim() : "")
    || "default";
  if (currentContext === "default") return "/var/run/docker.sock";

  const contextHash = createHash("sha256").update(currentContext).digest("hex");
  const metadata = await readRequiredJson(path.join(
    dockerConfigDirectory,
    "contexts",
    "meta",
    contextHash,
    "meta.json"
  ));
  const endpoints = metadata.Endpoints;
  const docker = endpoints && typeof endpoints === "object" && !Array.isArray(endpoints)
    ? (endpoints as Record<string, unknown>).docker
    : undefined;
  const host = docker && typeof docker === "object" && !Array.isArray(docker)
    ? (docker as Record<string, unknown>).Host
    : undefined;
  if (typeof host !== "string" || !host.trim()) {
    throw new DockerEngineClientError("configuration");
  }
  return socketPathFromDockerHost(host.trim());
}

async function canonicalSocketPath(socketPath: string) {
  try {
    const canonical = await fs.realpath(socketPath);
    const stat = await fs.stat(canonical);
    if (!stat.isSocket()) throw new DockerEngineClientError("configuration");
    return validateSocketPath(canonical);
  } catch (error) {
    if (error instanceof DockerEngineClientError) throw error;
    throw new DockerEngineClientError("configuration");
  }
}

function socketPathFromDockerHost(host: string) {
  if (!host.startsWith("unix://")) throw new DockerEngineClientError("configuration");
  try {
    const parsed = new URL(host);
    if (parsed.hostname || parsed.search || parsed.hash) {
      throw new DockerEngineClientError("configuration");
    }
    return validateSocketPath(decodeURIComponent(parsed.pathname));
  } catch (error) {
    if (error instanceof DockerEngineClientError) throw error;
    throw new DockerEngineClientError("configuration");
  }
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error instanceof DockerEngineClientError
      ? error
      : new DockerEngineClientError("configuration");
  }
}

async function readRequiredJson(filePath: string) {
  try {
    return await readJson(filePath);
  } catch {
    throw new DockerEngineClientError("configuration");
  }
}

async function readJson(filePath: string) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOCKER_CONFIG_BYTES) {
    throw new DockerEngineClientError("configuration");
  }
  return parseJsonObject(await fs.readFile(filePath));
}

function parseJsonObject(value: Buffer) {
  try {
    const parsed: unknown = JSON.parse(value.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DockerEngineClientError("configuration");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DockerEngineClientError) throw error;
    throw new DockerEngineClientError("configuration");
  }
}

function validateSocketPath(value: string) {
  if (!path.isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new DockerEngineClientError("configuration");
  }
  return path.resolve(value);
}

function validateAbsolutePath(value: string) {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new DockerEngineClientError("configuration");
  }
  return path.resolve(value);
}

function isUnversionedPath(requestPath: string) {
  return requestPath === "/_ping" || requestPath === "/version";
}

function positiveInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function remainingBudget(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DockerEngineClientError("timeout");
  return remaining;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortListener: (() => void) | undefined;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new DockerEngineClientError("timeout")), timeoutMs);
    timer.unref();
    promise.then((value) => finish(undefined, value), (error) => finish(error));
    if (signal) {
      abortListener = () => finish(new DockerEngineClientError("aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
