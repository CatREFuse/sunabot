import type { MessagingStatusV1 } from "../../packages/contracts/messaging/messages.js";
import { WebSocket, type WebSocketServer } from "ws";

type AccountConnection = NonNullable<MessagingStatusV1["accounts"]>[number];

export function summarizeOneBotConnections(connections: readonly AccountConnection[]) {
  const accounts = connections.map((connection) => ({ ...connection }));
  return {
    connected: accounts.length > 0,
    connections: accounts.length,
    selfIds: accounts.flatMap((account) => account.selfId ? [account.selfId] : []),
    accounts,
    connectedAt: accounts[0]?.connectedAt,
    lastEventAt: accounts.flatMap((account) => account.lastEventAt ? [account.lastEventAt] : []).sort().at(-1),
    lastMessageEventAt: accounts.flatMap((account) => account.lastMessageEventAt ? [account.lastMessageEventAt] : []).sort().at(-1)
  };
}

export function startOneBotHeartbeat(server: WebSocketServer) {
  const responsive = new WeakSet<WebSocket>();
  const onConnection = (socket: WebSocket) => {
    responsive.add(socket);
    socket.on("pong", () => { responsive.add(socket); });
  };
  server.on("connection", onConnection);
  const timer = setInterval(() => {
    for (const socket of server.clients) {
      if (!responsive.has(socket) || socket.readyState !== WebSocket.OPEN) {
        socket.terminate();
        continue;
      }
      responsive.delete(socket);
      socket.ping();
    }
  }, 10_000);
  timer.unref();
  server.once("close", () => {
    clearInterval(timer);
    server.off("connection", onConnection);
  });
}
