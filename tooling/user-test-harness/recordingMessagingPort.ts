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
import type {
  AttachmentResolutionInput,
  AttachmentResolverOptions,
  AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import type {
  ConversationFixtureAttachmentSource,
  HarnessAttachmentResolutionObservation
} from "./contracts.js";

export interface RecordingMessagingPortOptions {
  selfId: string;
  accountId: string;
  messages?: Record<string, MessageDetailsV1>;
  attachmentSources?: ConversationFixtureAttachmentSource[];
  sendFailure?: string;
}

export class RecordingMessagingPort implements MessagingPort, AttachmentSourcePort {
  readonly outboundMessages: OutboundMessageV1[] = [];
  readonly outboundAssets: OutboundConversationAssetV1[] = [];
  readonly pokes: PokeTargetV1[] = [];
  readonly attachmentResolutionCalls: HarnessAttachmentResolutionObservation[] = [];
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

  async resolveAttachment(
    input: AttachmentResolutionInput,
    _options: AttachmentResolverOptions = {}
  ) {
    return this.resolveFixtureAttachment(input, "resolve");
  }

  async resolveAttachmentFallback(
    input: Pick<AttachmentResolutionInput, "accountId" | "fileId" | "file">,
    _options: AttachmentResolverOptions = {}
  ) {
    try {
      return this.resolveFixtureAttachment(input, "fallback");
    } catch (error) {
      if (error instanceof Error && error.message === "USER_TEST_ATTACHMENT_SOURCE_UNAVAILABLE") {
        return undefined;
      }
      throw error;
    }
  }

  observations() {
    return [
      ...this.outboundMessages.map((message) => ({ kind: "message", value: message })),
      ...this.outboundAssets.map((asset) => ({ kind: "asset", value: asset })),
      ...this.pokes.map((target) => ({ kind: "poke", value: target }))
    ];
  }

  private resolveFixtureAttachment(
    input: Pick<AttachmentResolutionInput, "accountId" | "fileId" | "file">,
    strategy: HarnessAttachmentResolutionObservation["strategy"]
  ) {
    if (input.accountId !== this.options.accountId) {
      this.attachmentResolutionCalls.push({
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.fileId ? { fileId: input.fileId } : {}),
        ...(input.file ? { file: input.file } : {}),
        strategy,
        outcome: "account_mismatch"
      });
      throw new Error("USER_TEST_ATTACHMENT_ACCOUNT_MISMATCH");
    }
    const source = this.options.attachmentSources?.find((candidate) => (
      candidate.fileId === input.fileId ||
      (!input.fileId && candidate.name === input.file)
    ));
    this.attachmentResolutionCalls.push({
      accountId: input.accountId,
      ...(input.fileId ? { fileId: input.fileId } : {}),
      ...(input.file ? { file: input.file } : {}),
      strategy,
      outcome: source ? "resolved" : "missing"
    });
    if (!source) throw new Error("USER_TEST_ATTACHMENT_SOURCE_UNAVAILABLE");
    return {
      kind: "base64" as const,
      base64: source.contentBase64,
      via: "file_content" as const
    };
  }
}
