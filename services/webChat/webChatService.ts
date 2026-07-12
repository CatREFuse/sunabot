import type { InboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import type { SunaRuntime } from "../../src/runtime.js";
import { WEB_CHAT_CONVERSATION_ID } from "../../src/runtime/messagingAttachmentHelpers.js";
import { DIRECT_REPLY_TIMEOUT_MS } from "../../src/runtime/runtimeContracts.js";
import { WebChatDeliveryAdapter } from "./webChatDelivery.js";

export class WebChatService {
  private messageSequence = 0;
  private pendingTurn: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: SunaRuntime) {}

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
    const signal = AbortSignal.timeout(DIRECT_REPLY_TIMEOUT_MS);
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
