import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { resolvePublicWebTarget } from "../../adapters/webfetch/urlPolicy.js";

const MAX_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROXY_UPSTREAM_TIMEOUT_MS = 15_000;

export interface SafeProxyHandle {
  url: string;
  close(): Promise<void>;
}

export async function startSafeWebProxy(): Promise<SafeProxyHandle> {
  const server = http.createServer((request, response) => {
    void proxyHttpRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.on("connect", (request, client, head) => {
    void proxyConnect(request, client, head).catch(() => client.destroy());
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
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function proxyConnect(request: http.IncomingMessage, client: Duplex, head: Buffer) {
  const authority = request.url ?? "";
  const separator = authority.lastIndexOf(":");
  if (separator <= 0) throw new Error("invalid CONNECT authority");
  const hostname = authority.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(authority.slice(separator + 1));
  if (port !== 443) throw new Error("CONNECT port rejected");
  const target = await resolvePublicWebTarget(`https://${formatHost(hostname)}/`);
  const selected = target.addresses[0]!;
  const upstream = net.connect({ host: selected.address, port: 443, family: selected.family });
  upstream.setTimeout(PROXY_UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  // CONNECT clients are net.Socket instances at runtime, while Node's
  // IncomingMessage typing exposes the generic Duplex interface here.
  (client as net.Socket).setTimeout(PROXY_UPSTREAM_TIMEOUT_MS, () => client.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once("connect", resolve);
      upstream.once("error", reject);
    });
    if (client.destroyed) throw new Error("proxy client closed");
    client.write("HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.pipe(client);
    client.pipe(upstream);
  } catch (error) {
    upstream.destroy();
    throw error;
  }
}

async function proxyHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
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
    if (declaredLength > MAX_PROXY_RESPONSE_BYTES) {
      upstreamResponse.destroy();
      response.writeHead(502);
      response.end();
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedResponseHeaders(upstreamResponse.headers));
    let received = 0;
    upstreamResponse.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_PROXY_RESPONSE_BYTES) {
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
  const output: http.OutgoingHttpHeaders = { ...headers, host };
  for (const key of ["authorization", "cookie", "proxy-authorization", "proxy-connection", "origin", "referer"]) delete output[key];
  return output;
}

function sanitizedResponseHeaders(headers: http.IncomingHttpHeaders) {
  const output = { ...headers };
  delete output["set-cookie"];
  return output;
}

function formatHost(hostname: string) {
  return net.isIPv6(hostname) ? `[${hostname}]` : hostname;
}
