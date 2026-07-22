import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { resolvePublicWebTarget } from "../../adapters/webfetch/urlPolicy.js";

const MAX_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RENDER_REQUESTS = 32;
const MAX_RENDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROXY_UPSTREAM_TIMEOUT_MS = 15_000;
const BUDGET_HEADER = "x-sunabot-render-budget";

interface RenderBudget {
  requests: number;
  bytes: number;
}

export interface SafeProxyHandle {
  url: string;
  openBudget(): { id: string; close(): void };
  close(): Promise<void>;
}

export async function startSafeWebProxy(): Promise<SafeProxyHandle> {
  const budgets = new Map<string, RenderBudget>();
  const server = http.createServer((request, response) => {
    void proxyHttpRequest(request, response, budgets).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.on("connect", (_request, client) => {
    rejectConnect(client);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("safe proxy address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    openBudget: () => {
      const id = randomUUID();
      budgets.set(id, { requests: 0, bytes: 0 });
      return { id, close: () => budgets.delete(id) };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export function rejectConnect(client: Duplex) {
  client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

async function proxyHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  budgets: Map<string, RenderBudget>
) {
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  const budgetId = firstHeader(request.headers[BUDGET_HEADER]);
  const budget = budgets.get(budgetId);
  if (!budget || budget.requests >= MAX_RENDER_REQUESTS) {
    response.writeHead(429);
    response.end();
    return;
  }
  budget.requests += 1;
  const target = await resolvePublicWebTarget(request.url ?? "");
  if (target.url.protocol !== "http:") throw new Error("absolute HTTP proxy URL required");
  const selected = target.addresses[0]!;
  const headers = sanitizedHeaders(request.headers, target.url.host);
  const upstream = http.request({
    hostname: selected.address,
    family: selected.family,
    port: 80,
    method: "GET",
    path: `${target.url.pathname}${target.url.search}`,
    headers
  }, (upstreamResponse) => {
    const declaredLength = Number(upstreamResponse.headers["content-length"] ?? 0);
    const contentEncoding = firstHeader(upstreamResponse.headers["content-encoding"]).trim().toLowerCase();
    if (declaredLength > MAX_PROXY_RESPONSE_BYTES || (contentEncoding && contentEncoding !== "identity")) {
      upstreamResponse.destroy();
      response.writeHead(502);
      response.end();
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedResponseHeaders(upstreamResponse.headers));
    let received = 0;
    upstreamResponse.on("data", (chunk: Buffer) => {
      received += chunk.length;
      budget.bytes += chunk.length;
      if (received > MAX_PROXY_RESPONSE_BYTES || budget.bytes > MAX_RENDER_RESPONSE_BYTES) {
        upstreamResponse.destroy();
        response.destroy();
      }
    });
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(PROXY_UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.once("aborted", () => upstream.destroy());
  upstream.end();
}

function sanitizedHeaders(headers: http.IncomingHttpHeaders, host: string) {
  const output: http.OutgoingHttpHeaders = { ...headers, host, "accept-encoding": "identity" };
  for (const key of ["authorization", "cookie", "proxy-authorization", "proxy-connection", "origin", "referer", BUDGET_HEADER]) delete output[key];
  return output;
}

function sanitizedResponseHeaders(headers: http.IncomingHttpHeaders) {
  const output = { ...headers };
  delete output["set-cookie"];
  return output;
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
