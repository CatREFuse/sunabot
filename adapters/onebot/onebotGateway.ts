import http from "node:http";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer } from "ws";
import type { OutboundMediaDelivery } from "../../services/delivery/outboundMedia.js";
import type { AppConfig } from "../../src/types.js";
import type {
  AttachmentResolutionInput,
  AttachmentResolverOptions,
  AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import type {
  ConversationDirectoryPort,
  InboundMessageV1,
  MessageLookupContextV1,
  MessagingPort,
  MessagingReceiptV1,
  OutboundMessageV1,
  SenderIdentityV1,
  SenderLookupV1
} from "../../packages/contracts/messaging/messages.js";
import {
  extractOneBotMessageDetails,
  extractOneBotReceiptMessageId,
  extractOneBotSender,
  parseOneBotInboundMessage
} from "./inboundMessageAdapter.js";
import type { OneBotEvent } from "./protocol.js";
import {
  loadOneBotConversationDirectory,
  resolveOneBotAttachment,
  resolveOneBotAttachmentFallback
} from "./queryAdapter.js";

interface PendingAction {
  action: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES = 384 * 1024 * 1024;
export const ONEBOT_LOOPBACK_MAX_PAYLOAD_BYTES = 384 * 1024 * 1024;
export const ONEBOT_UNAUTHENTICATED_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

export interface OneBotEventTrace {
  receivedAt: string;
  postType?: string;
  messageType?: string;
  detailType?: string;
  selfId?: number;
  userId?: number;
  groupId?: number;
  messageId?: number;
  text?: string;
}

export interface OneBotGatewayDelegate {
  handleInboundMessage(message: InboundMessageV1, gateway: MessagingPort): Promise<void>;
}

export interface OutboundImageAsset {
  url?: string;
  filePath?: string;
}

export interface OneBotGatewayOptions {
  outboundMedia?: OutboundMediaDelivery;
}

export class OneBotGateway extends EventEmitter implements MessagingPort, ConversationDirectoryPort, AttachmentSourcePort {
  private readonly wss: WebSocketServer;
  private readonly sockets = new Map<WebSocket, { selfId?: string; connectedAt: string }>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly recentEvents: OneBotEventTrace[] = [];
  private lastEventAtValue?: string;
  private lastMessageEventAtValue?: string;
  private mounted = false;
  private upgradePending = false;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly server: http.Server,
    private config: AppConfig,
    private readonly delegate: OneBotGatewayDelegate,
    private readonly options: OneBotGatewayOptions = {}
  ) {
    super();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: process.env[config.onebot.accessTokenEnv]
        ? ONEBOT_AUTHENTICATED_MAX_PAYLOAD_BYTES
        : ONEBOT_LOOPBACK_MAX_PAYLOAD_BYTES
    });
  }

  mount() {
    if (this.closing) throw new Error("OneBot gateway is closing or already closed.");
    if (this.mounted) return;
    this.mounted = true;
    this.server.on("upgrade", this.handleUpgrade);

    this.wss.on("connection", (ws, _request, selfId?: string) => {
      const wasDisconnected = this.sockets.size === 0;
      const connectedAt = new Date().toISOString();
      this.sockets.set(ws, { selfId, connectedAt });
      if (wasDisconnected) {
        this.emit("connected", { connectedAt, selfId });
      }

      ws.on("message", (data) => {
        void this.handleMessage(ws, data.toString());
      });

      ws.on("close", () => {
        const removed = this.sockets.delete(ws);
        if (removed && this.sockets.size === 0 && !this.closing) {
          this.emit("disconnected", { at: new Date().toISOString() });
        }
      });

      ws.on("error", (error) => {
        console.error("[onebot] websocket error", error);
        this.emit("error", error);
      });
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.mounted) {
      this.server.off("upgrade", this.handleUpgrade);
      this.mounted = false;
    }
    this.upgradePending = false;
    const wasConnected = this.sockets.size > 0;
    for (const socket of this.sockets.keys()) socket.terminate();
    this.sockets.clear();
    if (wasConnected) this.emit("disconnected", { at: new Date().toISOString() });
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`OneBot connection closed before action completed: ${pending.action}`));
      this.pending.delete(echo);
    }
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.wss.close((error) => error ? reject(error) : resolve());
    });
    return this.closePromise;
  }

  private readonly handleUpgrade = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: string, code: string) => rejectUpgrade(socket, status, code);
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "/", "http://localhost");
    } catch {
      reject("400 Bad Request", "ONEBOT_INVALID_URL");
      return;
    }
    if (requestUrl.pathname !== this.config.onebot.reverseWsPath) {
      reject("404 Not Found", "ONEBOT_PATH_NOT_FOUND");
      return;
    }
    if (request.headers.origin) {
      reject("403 Forbidden", "ONEBOT_BROWSER_ORIGIN_REJECTED");
      return;
    }

    const token = process.env[this.config.onebot.accessTokenEnv];
    if (!token && (
      !isLoopbackRemoteAddress(request.socket.remoteAddress) ||
      !isTrustedTokenlessHost(request.headers.host)
    )) {
      reject("403 Forbidden", "ONEBOT_TOKEN_REQUIRED");
      return;
    }
    const queryToken = requestUrl.searchParams.get("access_token");
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token && token !== queryToken && token !== headerToken) {
      reject("401 Unauthorized", "ONEBOT_TOKEN_INVALID");
      return;
    }
    if (this.sockets.size > 0 || this.upgradePending) {
      reject("409 Conflict", "ONEBOT_CONNECTION_ALREADY_ACTIVE");
      return;
    }

    this.upgradePending = true;
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.upgradePending = false;
        const selfId = request.headers["x-self-id"] ? String(request.headers["x-self-id"]) : undefined;
        this.wss.emit("connection", ws, request, selfId);
      });
    } catch {
      this.upgradePending = false;
      reject("400 Bad Request", "ONEBOT_UPGRADE_FAILED");
    }
  };

  updateConfig(config: AppConfig) {
    this.config = config;
  }

  getStatus() {
    const socketValues = [...this.sockets.values()];
    const selfIds = socketValues.flatMap((socket) => (socket.selfId ? [socket.selfId] : []));
    return {
      connected: this.sockets.size > 0,
      connections: this.sockets.size,
      selfIds,
      connectedAt: socketValues[0]?.connectedAt,
      lastEventAt: this.lastEventAtValue,
      lastMessageEventAt: this.lastMessageEventAtValue
    };
  }

  getRecentEvents() {
    return this.recentEvents.slice();
  }

  async sendPrivateMessage(userId: number, message: string) {
    return this.sendAction("send_private_msg", {
      user_id: userId,
      message
    });
  }

  async sendPrivateRichMessage(userId: number, text: string, images: OutboundImageAsset[]) {
    const imageSources = await this.resolveImageSources(images);
    return this.sendAction("send_private_msg", {
      user_id: userId,
      message: richMessage(text, imageSources)
    });
  }

  async sendGroupMessage(groupId: number, message: string, options: { replyToMessageId?: number } = {}) {
    return this.sendAction("send_group_msg", {
      group_id: groupId,
      message: options.replyToMessageId ? replyMessage(options.replyToMessageId, message) : message
    });
  }

  async sendGroupRichMessage(groupId: number, text: string, images: OutboundImageAsset[], options: { replyToMessageId?: number } = {}) {
    const imageSources = await this.resolveImageSources(images);
    return this.sendAction("send_group_msg", {
      group_id: groupId,
      message: richMessage(text, imageSources, options.replyToMessageId)
    });
  }

  async dispatchAction(action: string, params: Record<string, unknown>) {
    const ws = [...this.sockets.keys()].find((socket) => socket.readyState === WebSocket.OPEN);
    if (!ws) throw new Error("OneBot is not connected.");
    const payload = JSON.stringify({ action, params });
    await new Promise<void>((resolve, reject) => {
      ws.send(payload, (error) => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      });
    });
  }

  async sendAction(action: string, params: Record<string, unknown>) {
    const ws = [...this.sockets.keys()].find((socket) => socket.readyState === WebSocket.OPEN);
    if (!ws) {
      throw new Error("OneBot is not connected.");
    }

    const echo = nanoid();
    const payload = JSON.stringify({ action, params, echo });

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action timeout: ${action}`));
      }, 15_000);
      this.pending.set(echo, { action, resolve, reject, timer });
    });

    ws.send(payload, (error) => {
      if (!error) return;
      const pending = this.pending.get(echo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(echo);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return response;
  }

  async send(message: OutboundMessageV1): Promise<MessagingReceiptV1> {
    const text = sanitizeOneBotOutboundText(message.text);
    const images: OutboundImageAsset[] = message.media.map((asset) => ({
      url: asset.url,
      filePath: asset.source === "shared_file" ? asset.filePath : undefined
    }));
    const response = message.groupId
      ? images.length
        ? await this.sendGroupRichMessage(message.groupId, text, images, {
          replyToMessageId: message.replyToMessageId
        })
        : await this.sendGroupMessage(message.groupId, text, {
          replyToMessageId: message.replyToMessageId
        })
      : images.length
        ? await this.sendPrivateRichMessage(message.userId, text, images)
        : await this.sendPrivateMessage(message.userId, text);
    return {
      accepted: true,
      ...(extractOneBotReceiptMessageId(response) ? { messageId: extractOneBotReceiptMessageId(response) } : {})
    };
  }

  async resolveSender(input: SenderLookupV1): Promise<SenderIdentityV1> {
    const payload = input.groupId
      ? await this.sendAction("get_group_member_info", {
        group_id: input.groupId,
        user_id: input.userId,
        no_cache: false
      })
      : await this.sendAction("get_stranger_info", {
        user_id: input.userId,
        no_cache: false
      });
    return extractOneBotSender(payload, input.userId);
  }

  async getMessage(messageId: number, context: MessageLookupContextV1 = {}) {
    const payload = await this.sendAction("get_msg", { message_id: messageId });
    return extractOneBotMessageDetails(payload, { ...context, messageId });
  }

  conversationDirectoryGeneration() {
    return String(this.getStatus().connectedAt ?? "unknown");
  }

  loadConversationDirectory() {
    return loadOneBotConversationDirectory(this);
  }

  resolveAttachment(input: AttachmentResolutionInput, options: AttachmentResolverOptions = {}) {
    return resolveOneBotAttachment(this, input, options);
  }

  resolveAttachmentFallback(
    input: Pick<AttachmentResolutionInput, "fileId" | "file">,
    options: AttachmentResolverOptions = {}
  ) {
    return resolveOneBotAttachmentFallback(this, input, options);
  }

  private async resolveImageSources(images: OutboundImageAsset[]) {
    const sources = await Promise.all(images.map(async (image) => {
      if (image.filePath && this.options.outboundMedia) {
        return this.options.outboundMedia.createReference(image.filePath);
      }
      if (image.url && /^https?:\/\//i.test(image.url)) return image.url;
      return image.filePath ?? "";
    }));
    return sources.filter(Boolean);
  }

  private async handleMessage(ws: WebSocket, data: string) {
    let event: OneBotEvent;
    try {
      event = JSON.parse(data) as OneBotEvent;
    } catch {
      return;
    }

    if (event.echo && this.pending.has(event.echo)) {
      const pending = this.pending.get(event.echo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(event.echo);
      const error = getActionError(pending.action, event);
      if (error) {
        pending.reject(error);
      } else {
        pending.resolve(event);
      }
      return;
    }

    if (event.self_id) {
      const socketInfo = this.sockets.get(ws);
      if (socketInfo) {
        socketInfo.selfId = String(event.self_id);
      }
    }

    if (event.post_type) {
      this.lastEventAtValue = new Date().toISOString();
      if (event.post_type === "message") {
        this.lastMessageEventAtValue = this.lastEventAtValue;
      }
      this.recordEventTrace(event, this.lastEventAtValue);
      this.emit("event", event);
      const inbound = parseOneBotInboundMessage(event);
      if (!inbound) return;
      void this.delegate.handleInboundMessage(inbound, this).catch((error) => {
        console.error("[onebot] event handling failed", {
          postType: event.post_type,
          messageType: event.message_type,
          messageId: event.message_id,
          userId: event.user_id,
          groupId: event.group_id,
          error
        });
      });
    }
  }

  private recordEventTrace(event: OneBotEvent, receivedAt: string) {
    this.recentEvents.unshift({
      receivedAt,
      postType: event.post_type,
      messageType: event.message_type,
      detailType: eventDetailType(event),
      selfId: event.self_id,
      userId: event.user_id,
      groupId: event.group_id,
      messageId: event.message_id,
      text: eventText(event)
    });
    this.recentEvents.splice(30);
  }
}

function getActionError(action: string, event: OneBotEvent) {
  const retcode = typeof event.retcode === "number" ? event.retcode : undefined;
  if (event.status !== "failed" && (retcode === undefined || retcode === 0 || retcode === 1)) {
    return null;
  }

  const detail = [
    event.status ? `status=${event.status}` : "",
    retcode !== undefined ? `retcode=${retcode}` : "",
    event.msg ? `msg=${event.msg}` : "",
    event.wording ? `wording=${event.wording}` : ""
  ].filter(Boolean).join(" ");

  return new Error(`OneBot action failed: ${action}${detail ? ` (${detail})` : ""}`);
}

function eventDetailType(event: OneBotEvent) {
  const payload = event as Record<string, unknown>;
  const value = payload.meta_event_type ?? payload.notice_type ?? payload.request_type ?? event.sub_type;
  return value == null ? undefined : String(value);
}

function eventText(event: OneBotEvent) {
  if (typeof event.raw_message === "string") return compactText(redactFileSegments(event.raw_message));
  if (typeof event.message === "string") return compactText(redactFileSegments(event.message));
  if (Array.isArray(event.message)) {
    return compactText(event.message.map((segment) => {
      if (segment.type === "text") return String(segment.data?.text ?? "");
      if (segment.type === "at") return `@${String(segment.data?.qq ?? "")}`;
      return `[${segment.type}]`;
    }).join(""));
  }
  return undefined;
}

function redactFileSegments(text: string) {
  return text.replace(/\[CQ:file(?:,[^\]]*)?\]/gi, "[file]");
}

function sanitizeOneBotOutboundText(text: string) {
  return text.replace(/\[CQ:image,[^\]]*\]/gi, "").trim();
}

function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function rejectUpgrade(socket: Duplex, status: string, code: string) {
  const body = `${code}\n`;
  socket.end(
    `HTTP/1.1 ${status}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => socket.destroy()
  );
}

export function isLoopbackRemoteAddress(address: string | undefined) {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4) && ipv4.split(".").every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export function isTrustedTokenlessHost(host: string | undefined) {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return isLoopbackHost(hostname);
}

function compactText(text: string) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function replyMessage(messageId: number, text: string) {
  return [
    {
      type: "reply",
      data: {
        id: String(messageId)
      }
    },
    {
      type: "text",
      data: {
        text
      }
    }
  ];
}

function richMessage(text: string, imageSources: string[], replyToMessageId?: number) {
  const segments = [];
  if (replyToMessageId) {
    segments.push({
      type: "reply",
      data: {
        id: String(replyToMessageId)
      }
    });
  }

  const trimmedText = text.trim();
  if (trimmedText) {
    segments.push({
      type: "text",
      data: {
        text: trimmedText
      }
    });
  }

  for (const imageSource of imageSources) {
    segments.push({
      type: "image",
      data: {
        file: imageSource
      }
    });
  }

  return segments.length ? segments : [{ type: "text", data: { text: "" } }];
}
