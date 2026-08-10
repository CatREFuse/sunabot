import {
  WebFetchError,
  type DynamicRendererPort
} from "../../services/webfetch/public.js";
import { readRendererAuthToken, validateRendererAuthToken } from "./rendererAuth.js";
import { resolveWebTarget } from "./urlPolicy.js";

const RENDER_TIMEOUT_MS = 15_000;
const MAX_RENDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROCESS_RENDERER_AUTH_TOKEN = loadProcessRendererAuthToken();

export class HttpDynamicRendererClient implements DynamicRendererPort {
  private readonly endpoint: string;
  private readonly authToken?: string;

  constructor(endpoint = defaultRendererEndpoint(), authToken = defaultRendererAuthToken()) {
    this.endpoint = normalizeRendererEndpoint(endpoint);
    this.authToken = authToken ? validateRendererAuthToken(authToken) : undefined;
  }

  async render(url: string, options: { signal?: AbortSignal } = {}) {
    if (!this.authToken) {
      throw new WebFetchError("DYNAMIC_RENDERER_UNAVAILABLE", "Renderer authentication is unavailable.");
    }
    const timeout = AbortSignal.timeout(RENDER_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(new URL("/render", this.endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url }),
        signal
      });
    } catch {
      throw new WebFetchError("DYNAMIC_RENDERER_UNAVAILABLE", "Renderer request failed.");
    }
    if (!response.ok) {
      throw new WebFetchError(
        response.status === 429 || response.status === 503 ? "DYNAMIC_RENDERER_UNAVAILABLE" : "DYNAMIC_RENDER_FAILED",
        "Renderer rejected the request."
      );
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RENDER_RESPONSE_BYTES) throw new WebFetchError("RESPONSE_TOO_LARGE", "Rendered DOM too large.");
    const text = await readBoundedResponse(response, MAX_RENDER_RESPONSE_BYTES);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new WebFetchError("DYNAMIC_RENDER_FAILED", "Renderer returned invalid JSON.");
    }
    if (typeof value.html !== "string" || typeof value.finalUrl !== "string") {
      throw new WebFetchError("DYNAMIC_RENDER_FAILED", "Renderer returned an invalid response.");
    }
    try {
      const finalUrl = resolveWebTarget(value.finalUrl).url.href;
      return { html: value.html, finalUrl };
    } catch {
      throw new WebFetchError("URL_NOT_ALLOWED", "Renderer returned an invalid URL.");
    }
  }

  async health(options: { signal?: AbortSignal } = {}) {
    const timeout = AbortSignal.timeout(2_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(new URL("/healthz", this.endpoint), { signal });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function defaultRendererAuthToken() {
  return PROCESS_RENDERER_AUTH_TOKEN;
}

function loadProcessRendererAuthToken() {
  try {
    return readRendererAuthToken();
  } catch {
    return undefined;
  }
}

async function readBoundedResponse(response: Response, maxBytes: number) {
  if (!response.body) throw new WebFetchError("DYNAMIC_RENDER_FAILED", "Renderer returned no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WebFetchError("RESPONSE_TOO_LARGE", "Rendered DOM too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function defaultRendererEndpoint() {
  const configured = process.env.SUNABOT_WEBFETCH_RENDERER_URL?.trim();
  const fallback = process.env.SUNABOT_RUNTIME_MODE === "docker"
    ? "http://webfetch-renderer:8790"
    : "http://127.0.0.1:8790";
  if (!configured) return fallback;
  try {
    const parsed = new URL(configured);
    const docker = process.env.SUNABOT_RUNTIME_MODE === "docker";
    const allowedHosts = docker
      ? new Set(["127.0.0.1", "::1", "webfetch-renderer"])
      : new Set(["127.0.0.1", "::1"]);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password ||
        parsed.port !== "8790" || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !allowedHosts.has(parsed.hostname.replace(/^\[|\]$/g, ""))) return fallback;
    return parsed.href;
  } catch {
    return fallback;
  }
}

function normalizeRendererEndpoint(value: string) {
  try {
    const parsed = new URL(value);
    const docker = process.env.SUNABOT_RUNTIME_MODE === "docker";
    const allowedHosts = docker
      ? new Set(["127.0.0.1", "::1", "webfetch-renderer"])
      : new Set(["127.0.0.1", "::1"]);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password ||
        parsed.port !== "8790" || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !allowedHosts.has(parsed.hostname.replace(/^\[|\]$/g, ""))) return "http://127.0.0.1:8790/";
    return parsed.href;
  } catch {
    return "http://127.0.0.1:8790/";
  }
}
