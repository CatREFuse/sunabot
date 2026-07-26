import type {
  MessageDetailsV1,
  MessageLookupContextV1,
  MessagingPort,
  OutboundConversationAssetV1,
  OutboundMessageV1,
  PokeTargetV1,
  SenderIdentityV1,
  SenderLookupV1
} from "../../packages/contracts/messaging/messages.js";

export interface RecordingMessagingPortOptions {
  selfId: string;
  accountId: string;
  messages?: Record<string, MessageDetailsV1>;
  sendFailure?: string;
}

export class RecordingMessagingPort implements MessagingPort {
  readonly outboundMessages: OutboundMessageV1[] = [];
  readonly outboundAssets: OutboundConversationAssetV1[] = [];
  readonly pokes: PokeTargetV1[] = [];
  private receiptSequence = 0;

  constructor(private readonly options: RecordingMessagingPortOptions) {}

  getStatus() {
    return {
      connected: true,
      connections: 1,
      selfIds: [this.options.selfId],
      accounts: [{
        accountId: this.options.accountId,
        selfId: this.options.selfId,
        connectedAt: new Date(0).toISOString()
      }]
    };
  }

  async send(message: OutboundMessageV1) {
    if (this.options.sendFailure) throw new Error(this.options.sendFailure);
    this.outboundMessages.push(structuredClone(message));
    return { accepted: true as const, messageId: `harness-message-${++this.receiptSequence}` };
  }

  async sendConversationAsset(message: OutboundConversationAssetV1) {
    if (this.options.sendFailure) throw new Error(this.options.sendFailure);
    this.outboundAssets.push(structuredClone(message));
    return { accepted: true as const, messageId: `harness-asset-${++this.receiptSequence}` };
  }

  async poke(target: PokeTargetV1) {
    if (this.options.sendFailure) throw new Error(this.options.sendFailure);
    this.pokes.push(structuredClone(target));
    return { accepted: true as const, messageId: `harness-poke-${++this.receiptSequence}` };
  }

  async resolveSender(input: SenderLookupV1): Promise<SenderIdentityV1> {
    return input.current ?? { id: String(input.userId), displayName: `user-${input.userId}` };
  }

  async getMessage(messageId: number, _context?: MessageLookupContextV1): Promise<MessageDetailsV1> {
    return this.options.messages?.[String(messageId)] ?? {
      text: "",
      media: [],
      attachments: [],
      replyMessageIds: [],
      sender: { id: "0" }
    };
  }

  observations() {
    return [
      ...this.outboundMessages.map((message) => ({ kind: "message", value: message })),
      ...this.outboundAssets.map((asset) => ({ kind: "asset", value: asset })),
      ...this.pokes.map((target) => ({ kind: "poke", value: target }))
    ];
  }
}
