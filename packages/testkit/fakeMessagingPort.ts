import type {
  AttachmentResolutionInput,
  AttachmentResolverOptions,
  AttachmentSourcePort,
  ResolvedAttachmentSource
} from "../contracts/media/media.js";
import type {
  ConversationDirectoryPort,
  ConversationDirectorySnapshotV1,
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

export class FakeConversationDirectoryPort implements ConversationDirectoryPort {
  generation = "fake-generation";
  readonly snapshots: ConversationDirectorySnapshotV1[] = [];
  readonly snapshotsByAccount = new Map<string, ConversationDirectorySnapshotV1[]>();
  readonly loadCountsByAccount = new Map<string, number>();
  readonly loadedAccountIds: string[] = [];
  loadCount = 0;

  constructor(snapshot?: ConversationDirectorySnapshotV1) {
    if (snapshot) this.snapshots.push(snapshot);
  }

  setAccountSnapshots(accountId: string, ...snapshots: ConversationDirectorySnapshotV1[]) {
    this.snapshotsByAccount.set(normalizeAccountId(accountId), snapshots);
  }

  conversationDirectoryGeneration(accountId?: string) {
    return `${this.generation}:${normalizeAccountId(accountId)}`;
  }

  async loadConversationDirectory(accountId?: string) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const snapshots = normalizedAccountId === "primary"
      ? this.snapshots
      : this.snapshotsByAccount.get(normalizedAccountId) ?? [];
    const loadCount = this.loadCountsByAccount.get(normalizedAccountId) ?? 0;
    const index = Math.min(loadCount, Math.max(0, snapshots.length - 1));
    this.loadCountsByAccount.set(normalizedAccountId, loadCount + 1);
    this.loadedAccountIds.push(normalizedAccountId);
    this.loadCount += 1;
    return structuredClone(snapshots[index] ?? emptyDirectorySnapshot());
  }
}

export class FakeAttachmentSourcePort implements AttachmentSourcePort {
  readonly resolveCalls: AttachmentResolutionInput[] = [];
  readonly fallbackCalls: Array<Pick<AttachmentResolutionInput, "fileId" | "file">> = [];

  constructor(
    private readonly source?: ResolvedAttachmentSource | Error,
    private readonly fallback?: ResolvedAttachmentSource | Error
  ) {}

  async resolveAttachment(input: AttachmentResolutionInput, _options: AttachmentResolverOptions = {}) {
    this.resolveCalls.push(structuredClone(input));
    if (this.source instanceof Error) throw this.source;
    if (!this.source) throw new Error("Fake attachment source is not configured.");
    return structuredClone(this.source);
  }

  async resolveAttachmentFallback(
    input: Pick<AttachmentResolutionInput, "fileId" | "file">,
    _options: AttachmentResolverOptions = {}
  ) {
    this.fallbackCalls.push(structuredClone(input));
    if (this.fallback instanceof Error) throw this.fallback;
    return this.fallback ? structuredClone(this.fallback) : undefined;
  }
}

function emptyDirectorySnapshot(): ConversationDirectorySnapshotV1 {
  return { friendsReady: false, groupsReady: false, friends: [], groups: [] };
}

function senderKey(userId: number, groupId?: number) {
  return `${groupId ?? "private"}:${userId}`;
}

function normalizeAccountId(accountId?: string) {
  return accountId?.trim() || "primary";
}
