import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer } from "ws";
import { asRecord, boundedTimeout } from "./shared.js";
import type { ActionResponseOptions, SmokeContext } from "./types.js";

export async function runOneBotSmoke(context: SmokeContext) {
  const productionQq = process.env.SUNABOT_PRODUCTION_QQ?.trim();
  if (productionQq && productionQq === context.napcatAccount) {
    throw new Error("隔离 NapCat 的 NAPCAT_ACCOUNT 与 SUNABOT_PRODUCTION_QQ 相同，拒绝重复登录。");
  }
  await assertPortFree("127.0.0.1", context.onebotPort);
  const server = http.createServer((_, response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      rejectUpgrade(socket, "400 Bad Request");
      return;
    }
    if (requestUrl.pathname !== context.onebotPath) {
      rejectUpgrade(socket, "404 Not Found");
      return;
    }
    const queryToken = requestUrl.searchParams.get("access_token") ?? "";
    const headerToken = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!safeTokenEqual(context.onebotToken, queryToken) && !safeTokenEqual(context.onebotToken, headerToken)) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
  });

  const connectionTimeoutMs = boundedTimeout("SUNABOT_SMOKE_ONEBOT_CONNECT_TIMEOUT_MS", 90_000, 5_000, 300_000);
  const connection = waitForOneBotConnection(wss, connectionTimeoutMs);
  await listen(server, context.onebotPort);
  try {
    console.log(`等待隔离 NapCat 连接 127.0.0.1:${context.onebotPort}${context.onebotPath}；Token 已隐藏。`);
    const websocket = await connection;
    const loginEcho = nanoid();
    const login = validateActionResponse(
      await sendOneBotAction(websocket, "get_login_info", {}, loginEcho),
      { expectedEcho: loginEcho, requireUserId: true }
    );
    const selfId = String(login.data.user_id);
    if (selfId !== context.napcatAccount) {
      throw new Error("OneBot 登录账号与隔离 workspace 的 NAPCAT_ACCOUNT 不一致。");
    }

    const markerId = `${new Date().toISOString()}-${nanoid(8)}`;
    const sendEcho = nanoid();
    const sent = validateActionResponse(await sendOneBotAction(websocket, "send_private_msg", {
      user_id: Number(context.adminQq),
      message: `[sunabot smoke ${markerId}] OneBot 管理员消息链路通过`
    }, sendEcho), { expectedEcho: sendEcho, requireMessageId: true });
    return { selfId, messageId: String(sent.data.message_id), markerId };
  } finally {
    for (const client of wss.clients) client.terminate();
    await closeWebSocketServer(wss);
    await closeHttpServer(server);
  }
}

export function validateActionResponse(value: unknown, options: ActionResponseOptions) {
  const response = asRecord(value, "OneBot action 回包");
  if (response.echo !== options.expectedEcho) throw new Error("OneBot action 回包 echo 不匹配。");
  if (response.status !== "ok" || response.retcode !== 0) throw new Error("OneBot action 回包未报告成功状态。");
  const data = asRecord(response.data, "OneBot action 回包 data");
  if (options.requireMessageId && !validId(data.message_id)) throw new Error("OneBot 发送回包缺少 message_id。");
  if (options.requireUserId && !validId(data.user_id)) throw new Error("OneBot 登录信息回包缺少 user_id。");
  return { ...response, data };
}

export function assertPortFree(host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`隔离端口 ${host}:${port} 已被占用。`)));
    server.listen(port, host, () => server.close(() => resolve()));
  });
}

function validId(value: unknown) {
  return (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && value.trim().length > 0);
}

function safeTokenEqual(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

function waitForOneBotConnection(wss: WebSocketServer, timeoutMs: number) {
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待隔离 NapCat 反向 WebSocket 连接超时。"));
    }, timeoutMs);
    const onConnection = (websocket: WebSocket) => {
      cleanup();
      resolve(websocket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      wss.off("connection", onConnection);
      wss.off("error", onError);
    };
    wss.on("connection", onConnection);
    wss.on("error", onError);
  });
}

function sendOneBotAction(websocket: WebSocket, action: string, params: Record<string, unknown>, echo: string) {
  const timeoutMs = boundedTimeout("SUNABOT_SMOKE_ONEBOT_ACTION_TIMEOUT_MS", 15_000, 1_000, 60_000);
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`OneBot action 超时：${action}`));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      let payload: unknown;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).echo !== echo) return;
      cleanup();
      resolve(payload);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`OneBot 在 ${action} 回包前断开。`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      websocket.off("message", onMessage);
      websocket.off("close", onClose);
      websocket.off("error", onError);
    };
    websocket.on("message", onMessage);
    websocket.once("close", onClose);
    websocket.once("error", onError);
    websocket.send(JSON.stringify({ action, params, echo }), (error) => {
      if (!error) return;
      cleanup();
      reject(error);
    });
  });
}

function listen(server: http.Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeWebSocketServer(wss: WebSocketServer) {
  return new Promise<void>((resolve) => wss.close(() => resolve()));
}

function closeHttpServer(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
