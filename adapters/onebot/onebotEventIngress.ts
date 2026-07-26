import type {
  InboundMessageV1,
  MessagingConnectionContextV1,
  MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import {
  hydrateOneBotForwardContent,
  parseOneBotInboundMessage
} from "./inboundMessageAdapter.js";
import type { OneBotEvent } from "./protocol.js";

export interface OneBotEventTrace {
  receivedAt: string;
  accountId?: string;
  postType?: string;
  messageType?: string;
  detailType?: string;
  selfId?: number;
  userId?: number;
  groupId?: number;
  messageId?: number;
  text?: string;
}

export interface OneBotEventDelegate {
  handleInboundMessage(
    message: InboundMessageV1,
    gateway: MessagingPort,
    connection: MessagingConnectionContextV1
  ): Promise<void>;
}

export interface OneBotIngressOptions {
  transport?: MessagingPort;
  resolveForwardMessage?: (messageId: string | number) => Promise<unknown>;
  receivedAt?: string;
}

export async function ingestOneBotEvent(input: {
  event: OneBotEvent;
  connection: MessagingConnectionContextV1;
  options: OneBotIngressOptions;
  defaultTransport: MessagingPort;
  defaultResolveForwardMessage: (messageId: string | number) => Promise<unknown>;
  delegate: OneBotEventDelegate;
  onReceived: (receivedAt: string) => void;
}) {
  if (!input.event.post_type) return undefined;
  const receivedAt = input.options.receivedAt ?? new Date().toISOString();
  input.onReceived(receivedAt);
  const inbound = parseOneBotInboundMessage(input.event);
  if (!inbound) return undefined;
  inbound.accountId = input.connection.accountId;
  await hydrateOneBotForwardContent(
    inbound,
    input.event,
    input.options.resolveForwardMessage ?? input.defaultResolveForwardMessage
  );
  await input.delegate.handleInboundMessage(
    inbound,
    input.options.transport ?? input.defaultTransport,
    input.connection
  );
  return inbound;
}
