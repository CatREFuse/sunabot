import type {
  InboundMessageV1,
  MessageDetailsV1,
  MessagingPort,
  MessagingReceiptV1,
  MessagingStatusV1,
  OutboundMessageV1,
  SenderIdentityV1,
  SenderLookupV1
} from "../../packages/contracts/messaging/messages.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";

const WEB_CHAT_CONVERSATION_ID = "web:admin";
const WEB_CHAT_REPLY_TIMEOUT_MS = 300_000;

export interface WebChatRuntimePort {
  adminIdentity(): { userId: string; name: string };
  getConversationMessages(conversationId: string, options: { limit: number }): object;
  incomingCaptureSequence(message: InboundMessageV1): number;
  recordIncomingMessage(message: InboundMessageV1, options: { expectedSequence: number }): unknown;
  replyToIncoming(
    conversationId: string,
    message: InboundMessageV1,
    delivery: MessagingPort,
    options: {
      captureSequence: number;
      signal: AbortSignal;
      allowAsyncCodex: false;
      allowAsyncImage: false;
      allowImageTools: false;
    }
  ): Promise<unknown>;
}

export class WebChatService {
  private messageSequence = 0;
  private pendingTurn: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: WebChatRuntimePort) {}

  messages() {
    return this.runtime.getConversationMessages(WEB_CHAT_CONVERSATION_ID, { limit: 200 });
  }

  async send(text: string) {
    const turn = this.pendingTurn.then(() => this.runTurn(text));
    this.pendingTurn = turn.then(() => undefined, () => undefined);
    return turn;
  }

  private async runTurn(text: string) {
    const admin = this.runtime.adminIdentity();
    const userId = Number(admin.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new ServiceError(
        409,
        "WEB_CHAT_ADMIN_QQ_REQUIRED",
        "请先在 Bot 设置中配置管理员 QQ。"
      );
    }

    const incoming: InboundMessageV1 = {
      schemaVersion: 1,
      transport: "web",
      scope: "private",
      messageId: Date.now() * 1_000 + this.messageSequence++ % 1_000,
      time: new Date().toISOString(),
      userId,
      sender: {
        id: String(userId),
        nickname: admin.name,
        displayName: admin.name
      },
      text,
      media: [],
      attachments: [],
      replyMessageIds: [],
      quoteReferences: [],
      mentionedSelf: true
    };
    const captureSequence = this.runtime.incomingCaptureSequence(incoming);
    this.runtime.recordIncomingMessage(incoming, { expectedSequence: captureSequence });

    const delivery = new WebChatDeliveryAdapter();
    const signal = AbortSignal.timeout(WEB_CHAT_REPLY_TIMEOUT_MS);
    await this.runtime.replyToIncoming(WEB_CHAT_CONVERSATION_ID, incoming, delivery, {
      captureSequence,
      signal,
      // Deferred jobs resume through the persistent OneBot session path today.
      // Web Chat keeps both deferred transports unavailable until it has its own durable delivery target.
      allowAsyncCodex: false,
      allowAsyncImage: false,
      allowImageTools: false
    });
    return { ok: true, delivered: delivery.messages.length, ...this.messages() };
  }
}

class WebChatDeliveryAdapter implements MessagingPort {
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
