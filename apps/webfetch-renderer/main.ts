import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { parseHTML } from "linkedom";
import { resolveWebTarget } from "../../adapters/webfetch/urlPolicy.js";
import { readRendererAuthToken, rendererRequestAuthorized } from "../../adapters/webfetch/rendererAuth.js";
import { RendererLimiter, RendererQueueFullError } from "./rendererLimiter.js";
import { startSafeWebProxy, type SafeProxyHandle } from "./safeProxy.js";

const MAX_DOM_BYTES = 4 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 12_000;
const PROCESS_TIMEOUT_MS = 15_000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUED_RENDERS = 16;

interface LightpandaExecutionOptions {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  killSignal: "SIGKILL";
  maxBuffer: number;
  shell: false;
  signal: AbortSignal;
  timeout: number;
  windowsHide: true;
}

export type LightpandaExecutor = (
  executable: string,
  args: string[],
  options: LightpandaExecutionOptions
) => Promise<string>;

export async function renderWithLightpanda(
  executable: string,
  safeProxy: SafeProxyHandle,
  url: string,
  signal: AbortSignal,
  execute: LightpandaExecutor = executeLightpanda
) {
  const budget = safeProxy.openBudget();
  try {
    const html = await execute(executable, [
      "fetch",
      "--dump",
      "html",
      "--with-base",
      "--http-proxy",
      safeProxy.url,
      "--proxy-bearer-token",
      budget.id,
      "--http-connect-timeout",
      String(NAVIGATION_TIMEOUT_MS),
      "--http-max-response-size",
      String(MAX_DOM_BYTES),
      "--http-timeout",
      String(NAVIGATION_TIMEOUT_MS),
      url
    ], {
      encoding: "utf8",
      env: {
        LIGHTPANDA_DISABLE_CORE_DUMP: "1",
        LIGHTPANDA_DISABLE_TELEMETRY: "true"
      },
      killSignal: "SIGKILL",
      maxBuffer: MAX_DOM_BYTES,
      shell: false,
      signal,
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: true
    });
    if (Buffer.byteLength(html, "utf8") > MAX_DOM_BYTES) {
      throw new Error("rendered DOM too large");
    }
    const { document } = parseHTML(html);
    const baseHref = document.querySelector("base[href]")?.getAttribute("href")?.trim();
    if (!baseHref) throw new Error("rendered DOM is missing its final URL");
    const finalUrl = resolveWebTarget(new URL(baseHref, url)).url.href;
    return { html, finalUrl };
  } finally {
    budget.close();
  }
}

async function startRenderer() {
  const host = readHost(process.env.SUNABOT_WEBFETCH_RENDERER_HOST);
  const port = readPort(process.env.SUNABOT_WEBFETCH_RENDERER_PORT, 8790);
  const runtimeIsolation = readRuntimeIsolation(process.env.SUNABOT_WEBFETCH_RUNTIME_ISOLATION);
  const executable = readLightpandaExecutable(process.env.SUNABOT_WEBFETCH_LIGHTPANDA_EXECUTABLE);
  const authToken = readRendererAuthToken();
  await access(executable, fsConstants.X_OK);

  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 });
  const limiter = new RendererLimiter(MAX_CONCURRENCY, MAX_QUEUED_RENDERS);
  const proxy = await startSafeWebProxy();
  let shuttingDown = false;

  app.get("/healthz", async (_request, reply) => {
    reply.code(200).send({
      ok: true,
      engine: "lightpanda",
      runtimeIsolation
    });
  });

  app.post<{ Body: { url?: unknown } }>("/render", async (request, reply) => {
    if (!rendererRequestAuthorized(request.headers.authorization, authToken)) {
      reply.header("cache-control", "no-store").code(401).send({
        ok: false,
        code: "RENDERER_AUTH_REQUIRED"
      });
      return;
    }
    if (!request.body
      || typeof request.body.url !== "string"
      || request.body.url.trim().length < 1
      || request.body.url.trim().length > 4_096
      || Object.keys(request.body).length !== 1) {
      reply.code(400).send({ ok: false, code: "INVALID_INPUT" });
      return;
    }
    let url: string;
    try {
      url = resolveWebTarget(request.body.url.trim()).url.href;
    } catch {
      reply.code(400).send({ ok: false, code: "URL_NOT_ALLOWED" });
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Renderer client disconnected."));
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const result = await limiter.run(
        () => renderWithLightpanda(executable, proxy, url, controller.signal),
        controller.signal
      );
      reply.code(200).send(result);
    } catch (error) {
      if (error instanceof RendererQueueFullError) {
        reply.code(429).send({ ok: false, code: "RENDER_QUEUE_FULL" });
      } else if (!controller.signal.aborted) {
        reply.code(502).send({ ok: false, code: "DYNAMIC_RENDER_FAILED" });
      }
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    limiter.close();
    await app.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

  await app.listen({ host, port });
}

function executeLightpanda(
  executable: string,
  args: string[],
  options: LightpandaExecutionOptions
) {
  return new Promise<string>((resolve, reject) => {
    execFile(executable, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function readLightpandaExecutable(value: string | undefined) {
  const executable = value?.trim();
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("WEBFETCH_LIGHTPANDA_EXECUTABLE_REQUIRED");
  }
  return executable;
}

function readPort(value: string | undefined, fallback: number) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid renderer port");
  return port;
}

function readHost(value: string | undefined) {
  const host = value?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("WEBFETCH_RENDERER_HOST_INVALID");
  }
  return host;
}

function readRuntimeIsolation(value: string | undefined) {
  const isolation = value?.trim();
  if (isolation === "linux-bubblewrap") return isolation;
  throw new Error("WEBFETCH_RUNTIME_ISOLATION_REQUIRED");
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) await startRenderer();
