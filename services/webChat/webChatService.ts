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
import { runModelTaskWithinDeadline } from "../../packages/contracts/model/modelTaskDeadline.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";

const WEB_CHAT_CONVERSATION_ID = "web:admin";
export const WEB_CHAT_REPLY_TIMEOUT_MS = AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS;

export interface WebChatRuntimePort {
  readonly runtimeSignal?: AbortSignal;
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
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly runtime: WebChatRuntimePort,
    private readonly apiShutdownSignal?: AbortSignal
  ) {}

  messages() {
    return this.runtime.getConversationMessages(WEB_CHAT_CONVERSATION_ID, { limit: 200 });
  }

  send(text: string, callerSignal?: AbortSignal) {
    const previousTurn = this.pendingTurn;
    const parentSignals = [
      this.shutdownController.signal,
      ...(this.runtime.runtimeSignal ? [this.runtime.runtimeSignal] : []),
      ...(this.apiShutdownSignal ? [this.apiShutdownSignal] : []),
      ...(callerSignal ? [callerSignal] : [])
    ];
    const parentSignal = parentSignals.length === 1
      ? parentSignals[0]!
      : AbortSignal.any(parentSignals);
    const turn = runModelTaskWithinDeadline(async (signal) => {
      await previousTurn;
      signal.throwIfAborted();
      return this.runTurn(text, signal);
    }, {
      timeoutMs: WEB_CHAT_REPLY_TIMEOUT_MS,
      parentSignal,
      timeoutError: () => webChatTimeoutError()
    }).catch((error) => {
      throw normalizeWebChatAbort(
        error,
        callerSignal,
        this.shutdownController.signal,
        this.apiShutdownSignal,
        this.runtime.runtimeSignal
      );
    });
    this.pendingTurn = turn.then(() => undefined, () => undefined);
    return turn;
  }

  close() {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(webChatShuttingDownError());
    }
  }

  private async runTurn(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    const captureSequence = this.runtime.incomingCaptureSequence(incoming);
    signal.throwIfAborted();
    this.runtime.recordIncomingMessage(incoming, { expectedSequence: captureSequence });
    signal.throwIfAborted();

    const delivery = new WebChatDeliveryAdapter(signal);
    await this.runtime.replyToIncoming(WEB_CHAT_CONVERSATION_ID, incoming, delivery, {
      captureSequence,
      signal,
      // Deferred jobs resume through the persistent OneBot session path today.
      // Web Chat keeps both deferred transports unavailable until it has its own durable delivery target.
      allowAsyncCodex: false,
      allowAsyncImage: false,
      allowImageTools: false
    });
    signal.throwIfAborted();
    return { ok: true, delivered: delivery.messages.length, ...this.messages() };
  }
}

class WebChatDeliveryAdapter implements MessagingPort {
  readonly messages: OutboundMessageV1[] = [];

  constructor(private readonly signal: AbortSignal) {}

  getStatus(): MessagingStatusV1 {
    return { connected: true, connections: 1, selfIds: ["web"] };
  }

  async send(message: OutboundMessageV1): Promise<MessagingReceiptV1> {
    this.signal.throwIfAborted();
    this.messages.push(message);
    this.signal.throwIfAborted();
    return { accepted: true, messageId: message.id };
  }

  async resolveSender(input: SenderLookupV1): Promise<SenderIdentityV1> {
    return input.current ?? { id: String(input.userId), displayName: "管理员" };
  }

  async getMessage(_messageId: number): Promise<MessageDetailsV1> {
    throw new Error("Web Chat 不支持读取外部消息。");
  }
}

function normalizeWebChatAbort(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  shutdownSignal: AbortSignal,
  apiShutdownSignal: AbortSignal | undefined,
  runtimeSignal: AbortSignal | undefined
) {
  if (error instanceof ServiceError) return error;
  if (shutdownSignal.aborted || apiShutdownSignal?.aborted || runtimeSignal?.aborted) {
    return webChatShuttingDownError();
  }
  if (callerSignal?.aborted) return webChatRequestAbortedError();
  return error;
}

function webChatTimeoutError() {
  return new ServiceError(
    504,
    "WEB_CHAT_REPLY_TIMEOUT",
    "Web Chat 回复超时，请重试。"
  );
}

function webChatRequestAbortedError() {
  return new ServiceError(
    499,
    "WEB_CHAT_REQUEST_ABORTED",
    "请求已取消。"
  );
}

function webChatShuttingDownError() {
  return new ServiceError(
    503,
    "WEB_CHAT_SHUTTING_DOWN",
    "Web Chat 正在关闭，请稍后重试。"
  );
}
