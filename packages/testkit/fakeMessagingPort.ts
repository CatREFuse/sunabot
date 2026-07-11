import type {
  MessageDetailsV1,
  MessagingPort,
  MessagingReceiptV1,
  OutboundMessageV1,
  SenderIdentityV1,
  SenderLookupV1
} from "../contracts/messaging/messages.js";

export class FakeMessagingPort implements MessagingPort {
  readonly sent: OutboundMessageV1[] = [];
  readonly senders = new Map<string, SenderIdentityV1>();
  readonly messages = new Map<number, MessageDetailsV1>();
  connected = true;

  getStatus() {
    return {
      connected: this.connected,
      connections: this.connected ? 1 : 0,
      selfIds: this.connected ? ["fake"] : []
    };
  }

  async send(message: OutboundMessageV1): Promise<MessagingReceiptV1> {
    if (!this.connected) throw new Error("Messaging adapter is disconnected.");
    this.sent.push(structuredClone(message));
    return { accepted: true, messageId: `fake-${this.sent.length}` };
  }

  async resolveSender(input: SenderLookupV1): Promise<SenderIdentityV1> {
    return this.senders.get(senderKey(input.userId, input.groupId))
      ?? input.current
      ?? { id: String(input.userId) };
  }

  async getMessage(messageId: number): Promise<MessageDetailsV1> {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`Unknown fake message: ${messageId}`);
    return structuredClone(message);
  }
}

function senderKey(userId: number, groupId?: number) {
  return `${groupId ?? "private"}:${userId}`;
}
