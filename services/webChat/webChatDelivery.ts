import type {
  MessageDetailsV1,
  MessagingPort,
  MessagingReceiptV1,
  MessagingStatusV1,
  OutboundMessageV1,
  SenderIdentityV1,
  SenderLookupV1
} from "../../packages/contracts/messaging/messages.js";

export class WebChatDeliveryAdapter implements MessagingPort {
  readonly messages: OutboundMessageV1[] = [];

  getStatus(): MessagingStatusV1 {
    return { connected: true, connections: 1, selfIds: ["web"] };
  }

  async send(message: OutboundMessageV1): Promise<MessagingReceiptV1> {
    this.messages.push(message);
    return { accepted: true, messageId: message.id };
  }

  async resolveSender(input: SenderLookupV1): Promise<SenderIdentityV1> {
    return input.current ?? { id: String(input.userId), displayName: "管理员" };
  }

  async getMessage(_messageId: number): Promise<MessageDetailsV1> {
    throw new Error("Web Chat 不支持读取外部消息。");
  }
}
