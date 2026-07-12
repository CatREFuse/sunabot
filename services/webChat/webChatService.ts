import type { InboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { WebChatDeliveryAdapter } from "./webChatDelivery.js";

const WEB_CHAT_CONVERSATION_ID = "web:admin";

export class WebChatService {
  private messageSequence = 0;

  constructor(private readonly runtime: SunaRuntime) {}

  messages() {
    return this.runtime.getConversationMessages(WEB_CHAT_CONVERSATION_ID, { limit: 200 });
  }

  async send(text: string, signal?: AbortSignal) {
    const admin = this.runtime.adminIdentity();
    const userId = Number(admin.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("请先在 Bot 设置中配置管理员 QQ。");
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
    await this.runtime.replyToIncoming(WEB_CHAT_CONVERSATION_ID, incoming, delivery, {
      captureSequence,
      signal,
      // Deferred jobs resume through the persistent OneBot session path today.
      // Web Chat keeps both deferred transports unavailable until it has its own durable delivery target.
      allowAsyncCodex: false,
      allowAsyncImage: false
    });
    return { ok: true, delivered: delivery.messages.length, ...this.messages() };
  }
}
