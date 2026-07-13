// @vitest-environment node
import http from "node:http";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { defaultConfig } from "../../src/config.js";
import {
  isLoopbackRemoteAddress,
  isTrustedTokenlessHost,
  OneBotGateway
} from "../../adapters/onebot/onebotGateway.js";
import { assertOneBotAccessToken } from "../../apps/api/server.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";

const originalAccessToken = process.env.ONEBOT_ACCESS_TOKEN;

afterEach(() => {
  if (originalAccessToken === undefined) delete process.env.ONEBOT_ACCESS_TOKEN;
  else process.env.ONEBOT_ACCESS_TOKEN = originalAccessToken;
  vi.restoreAllMocks();
});

describe("OneBot security boundaries", () => {
  it("redacts temporary file URLs and tokens from recent event traces", () => {
    const gateway = createGateway();
    const event: OneBotEvent = {
      post_type: "message",
      message_type: "private",
      user_id: 42,
      raw_message: "请读取[CQ:file,name=报告.pdf,url=https://cdn.example.test/file?token=secret,file_id=private-id]"
    };

    (gateway as unknown as {
      recordEventTrace(event: OneBotEvent, receivedAt: string): void;
    }).recordEventTrace(event, "2026-07-10T00:00:00.000Z");

    expect(gateway.getRecentEvents()[0]?.text).toBe("请读取[file]");
    expect(JSON.stringify(gateway.getRecentEvents())).not.toContain("token=secret");
    expect(JSON.stringify(gateway.getRecentEvents())).not.toContain("private-id");
  });

  it("refuses to start a split OneBot listener without a shared token", () => {
    delete process.env.ONEBOT_ACCESS_TOKEN;
    const config = defaultConfig();
    expect(() => assertOneBotAccessToken(config)).toThrow(
      "Cannot start the OneBot listener: ONEBOT_ACCESS_TOKEN is required"
    );
    process.env.ONEBOT_ACCESS_TOKEN = "unit-onebot-token";
    expect(() => assertOneBotAccessToken(config)).not.toThrow();
  });

  it("recognizes only loopback peers for tokenless reverse WebSocket access", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.24.1.9")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackRemoteAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackRemoteAddress("::ffff:192.168.1.10")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
    expect(isTrustedTokenlessHost("127.0.0.1:8787")).toBe(true);
    expect(isTrustedTokenlessHost("[::1]:8787")).toBe(true);
    expect(isTrustedTokenlessHost("host.docker.internal:8787")).toBe(false);
    expect(isTrustedTokenlessHost("attacker.invalid:8787")).toBe(false);
  });

  it("rejects browser-origin WebSocket handshakes even with a valid token", async () => {
    process.env.ONEBOT_ACCESS_TOKEN = "unit-onebot-token";
    const config = defaultConfig();
    const server = http.createServer();
    const gateway = new OneBotGateway(server, config, {
      handleInboundMessage: vi.fn(async () => undefined)
    });
    gateway.mount();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");

    const status = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${address.port}${config.onebot.reverseWsPath}?access_token=unit-onebot-token`,
        { origin: "https://attacker.invalid" }
      );
      client.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      client.once("open", () => reject(new Error("Untrusted browser-origin WebSocket was accepted.")));
      client.once("error", () => undefined);
    });

    expect(status).toBe(403);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("permits exactly one authenticated OneBot connection", async () => {
    process.env.ONEBOT_ACCESS_TOKEN = "unit-onebot-token";
    const config = defaultConfig();
    const server = http.createServer();
    const gateway = new OneBotGateway(server, config, {
      handleInboundMessage: vi.fn(async () => undefined)
    });
    gateway.mount();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
    const url = `ws://127.0.0.1:${address.port}${config.onebot.reverseWsPath}?access_token=unit-onebot-token`;
    const first = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });

    const secondStatus = await new Promise<number>((resolve, reject) => {
      const second = new WebSocket(url);
      second.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      second.once("open", () => reject(new Error("A second OneBot connection was accepted.")));
      second.once("error", () => undefined);
    });

    expect(secondStatus).toBe(409);
    expect(gateway.getStatus().connections).toBe(1);
    first.terminate();
    await new Promise<void>((resolve) => first.once("close", resolve));
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps two registered QQ connections and targeted actions isolated", async () => {
    process.env.ONEBOT_ACCESS_TOKEN = "unit-onebot-token";
    const config = defaultConfig();
    const server = http.createServer();
    const handleInboundMessage = vi.fn(async () => undefined);
    const gateway = new OneBotGateway(server, config, { handleInboundMessage }, {
      isAccountAllowed: (accountId) => accountId === "account-a" || accountId === "account-b"
    });
    gateway.mount();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
    const connect = async (accountId: string) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${address.port}${config.onebot.reverseWsPath}` +
        `?access_token=unit-onebot-token&account_id=${accountId}`
      );
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      return client;
    };
    const first = await connect("account-a");
    const second = await connect("account-b");

    expect(gateway.getStatus()).toMatchObject({
      connections: 2,
      accounts: expect.arrayContaining([
        expect.objectContaining({ accountId: "account-a" }),
        expect.objectContaining({ accountId: "account-b" })
      ])
    });

    second.once("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { action: string; echo: string };
      second.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 22222 }, echo: request.echo }));
    });
    const firstMessage = vi.fn();
    first.on("message", firstMessage);
    await expect(gateway.sendAction("get_login_info", {}, "account-b")).resolves.toMatchObject({
      data: { user_id: 22222 }
    });
    expect(firstMessage).not.toHaveBeenCalled();

    second.send(JSON.stringify({
      post_type: "message",
      message_type: "private",
      self_id: 22222,
      user_id: 33333,
      message_id: 1,
      time: 1,
      message: "你好",
      raw_message: "你好"
    }));
    await vi.waitFor(() => expect(handleInboundMessage).toHaveBeenCalledOnce());
    expect(handleInboundMessage.mock.calls[0]?.[2]).toMatchObject({ accountId: "account-b", selfId: "22222" });

    first.terminate();
    second.terminate();
    await Promise.all([
      new Promise<void>((resolve) => first.once("close", resolve)),
      new Promise<void>((resolve) => second.once("close", resolve))
    ]);
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("closes WebSocket upgrades sent to an unknown path", async () => {
    delete process.env.ONEBOT_ACCESS_TOKEN;
    const config = defaultConfig();
    const server = http.createServer();
    const gateway = new OneBotGateway(server, config, {
      handleInboundMessage: vi.fn(async () => undefined)
    });
    gateway.mount();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");

    try {
      const status = await Promise.race([
        new Promise<number>((resolve, reject) => {
          const request = http.request({
            host: "127.0.0.1",
            port: address.port,
            path: "/unknown-websocket",
            headers: {
              connection: "Upgrade",
              upgrade: "websocket",
              host: "attacker.invalid"
            }
          });
          request.once("response", (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          });
          request.once("upgrade", () => reject(new Error("Unknown WebSocket path was upgraded.")));
          request.once("error", reject);
          request.end();
        }),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("Unknown WebSocket upgrade was left open.")),
          1_000
        ))
      ]);

      expect(status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a malformed Host without crashing the upgrade handler", async () => {
    delete process.env.ONEBOT_ACCESS_TOKEN;
    const config = defaultConfig();
    const server = http.createServer();
    const gateway = new OneBotGateway(server, config, {
      handleInboundMessage: vi.fn(async () => undefined)
    });
    gateway.mount();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");

    try {
      const response = await Promise.race([
        new Promise<string>((resolve, reject) => {
          const socket = createConnection(address.port, "127.0.0.1");
          let received = "";
          socket.setEncoding("utf8");
          socket.once("connect", () => socket.write(
            `GET ${config.onebot.reverseWsPath} HTTP/1.1\r\n` +
            "Host: [\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n\r\n"
          ));
          socket.on("data", (chunk) => {
            received += chunk;
          });
          socket.once("close", () => resolve(received));
          socket.once("error", reject);
        }),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("Malformed Host upgrade was left open.")),
          1_000
        ))
      ]);

      expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/);
      expect(server.listening).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function createGateway() {
  return new OneBotGateway(http.createServer(), defaultConfig(), {
    handleInboundMessage: vi.fn(async () => undefined)
  });
}
