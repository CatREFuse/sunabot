import { once } from "node:events";
import http from "node:http";
import type { AppConfig } from "../../packages/contracts/admin/public.js";

export type OneBotListenerAddress = { host: string; port: number };

export function assertOneBotAccessToken(
  config: Pick<AppConfig, "onebot">,
  env: NodeJS.ProcessEnv = process.env
) {
  const variable = config.onebot.accessTokenEnv;
  if (env[variable]?.trim()) return;
  throw new Error(
    `Cannot start the OneBot listener: ${variable} is required. ` +
    "Configure the same non-empty token in Sunabot Core and NapCat."
  );
}

export function resolveOneBotListenerAddress(
  env: { SUNABOT_ONEBOT_HOST?: string; SUNABOT_ONEBOT_PORT?: string } = process.env
): OneBotListenerAddress {
  const host = env.SUNABOT_ONEBOT_HOST?.trim() || "127.0.0.1";
  const rawPort = env.SUNABOT_ONEBOT_PORT?.trim() || "8788";
  const port = Number(rawPort);
  validateListenerAddress(host, port, false);
  return { host, port };
}

export function createOneBotHttpServer() {
  return http.createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?", 1)[0] === "/healthz") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end("ONEBOT_WEBSOCKET_UPGRADE_REQUIRED\n");
  });
}

export async function startOneBotHttpServer(
  server: http.Server,
  address: OneBotListenerAddress,
  allowEphemeralPort: boolean
) {
  validateListenerAddress(address.host, address.port, allowEphemeralPort);
  const listening = once(server, "listening");
  server.listen(address.port, address.host);
  await listening;
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("OneBot listener did not expose a TCP address.");
  return { host: address.host, port: bound.port };
}

export async function closeOneBotHttpServer(server: http.Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  const closed = once(server, "close");
  server.close();
  await closed;
}

function validateListenerAddress(host: string, port: number, allowEphemeralPort: boolean) {
  if (!host.trim()) throw new Error("SUNABOT_ONEBOT_HOST must not be empty.");
  const minimum = allowEphemeralPort ? 0 : 1;
  if (!Number.isSafeInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`SUNABOT_ONEBOT_PORT must be an integer between ${minimum} and 65535.`);
  }
}
