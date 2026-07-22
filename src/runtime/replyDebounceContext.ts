import type {
  GroupThreadContextSnapshotV1,
  UserGroupOrchestratorResultV1
} from "../../packages/contracts/session/runtimeMessages.js";
import type { AttachmentService } from "../../services/media/attachments/service.js";
import type { AttachmentModelContext } from "../../services/media/attachments/types.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../types.js";
import { inboundImageUrls } from "../../packages/contracts/messaging/messages.js";
import { isAdminUserId, toContextChatMessage } from "./conversationMemoryHelpers.js";
import type { PrepareGroupThreadContextOptions } from "./groupThreadPipeline.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { AdminIdentity } from "./runtimeContracts.js";

export interface ReplyDebounceContextOptions {
  captureSequence?: number;
  contextThroughSequence?: number;
  signal?: AbortSignal;
  threadContext?: GroupThreadContextSnapshotV1;
  orchestratorResult?: UserGroupOrchestratorResultV1;
  skipGroupThreadPreparation?: boolean;
}

interface ReplyDebounceContextHost { readonly attachmentService: Pick<AttachmentService, "buildModelContext">; readonly conversationRecords: ReadonlyMap<string, ConversationRecord>; adminIdentity(): AdminIdentity; prepareGroupThreadContext(incoming: ParsedIncomingMessage, options: PrepareGroupThreadContextOptions): Promise<GroupThreadContextSnapshotV1 | undefined>; selectRelevantAttachments(incoming: ParsedIncomingMessage, query: string, contextThroughSequence?: number, contextFromSequence?: number): Parameters<AttachmentService["buildModelContext"]>[0]; }

export function resolveReplyContextCaptureSequence(
  captureSequence: unknown,
  contextThroughSequence: unknown
): number | undefined {
  return typeof contextThroughSequence === "number" && Number.isFinite(contextThroughSequence)
    ? contextThroughSequence + 1
    : typeof captureSequence === "number" && Number.isFinite(captureSequence)
      ? captureSequence
      : undefined;
}

export class ReplyDebounceContext {
  readonly historyCaptureSequence: number | undefined;
  readonly contextCaptureSequence: number | undefined;
  private readonly senderOnlyGroupBatch: boolean;

  constructor(
    private readonly host: ReplyDebounceContextHost,
    private readonly incoming: ParsedIncomingMessage,
    private readonly options: ReplyDebounceContextOptions
  ) {
    this.historyCaptureSequence = validSequence(options.captureSequence);
    const contextThroughSequence = validSequence(options.contextThroughSequence);
    this.senderOnlyGroupBatch = incoming.scope !== "private" &&
      this.historyCaptureSequence != null && contextThroughSequence != null;
    this.contextCaptureSequence = resolveReplyContextCaptureSequence(
      options.captureSequence,
      options.contextThroughSequence
    );
  }

  buildCurrentPrompt(prompt: string, promptOverridesTrigger: boolean) {
    const messages = this.currentBatchMessages();
    if (!messages.length) return prompt;
    const admin = this.host.adminIdentity();
    const formatted = messages.map((message) => ({
      id: message.id,
      sequence: validSequence(message.sequence),
      content: toContextChatMessage(message, isAdminUserId(message.userId, admin), admin).content
    }));
    if (promptOverridesTrigger) {
      return [...formatted.map((message) => message.content), prompt].filter(Boolean).join("\n\n");
    }
    const triggerMessageId = this.incoming.messageId == null
      ? undefined
      : String(this.incoming.messageId);
    const triggerSequence = triggerMessageId == null
      ? validSequence(this.options.captureSequence)
      : undefined;
    return [
      prompt,
      ...formatted
        .filter((message) => triggerMessageId != null
          ? message.id !== triggerMessageId
          : message.sequence !== triggerSequence)
        .map((message) => message.content)
    ].filter(Boolean).join("\n\n");
  }

  currentImageUrls() {
    return [...new Set([
      ...inboundImageUrls(this.incoming),
      ...this.currentBatchMessages().flatMap((message) => message.imageUrls ?? [])
    ])];
  }

  async prepareThreadContext(): Promise<GroupThreadContextSnapshotV1 | undefined> {
    if (
      this.incoming.scope === "private" ||
      this.options.threadContext ||
      this.options.skipGroupThreadPreparation
    ) return this.options.threadContext;
    return this.host.prepareGroupThreadContext(this.incoming, {
      captureSequence: this.options.captureSequence,
      contextThroughSequence: this.senderOnlyGroupBatch
        ? this.options.captureSequence
        : this.options.contextThroughSequence,
      signal: this.options.signal
    });
  }

  async buildAttachmentContext(query: string): Promise<AttachmentModelContext> {
    const selected = this.host.selectRelevantAttachments(
      this.incoming,
      query,
      this.options.contextThroughSequence,
      this.options.captureSequence
    );
    return selected.length
      ? this.host.attachmentService.buildModelContext(selected, query)
      : { text: "", localImagePaths: [], attachments: [] };
  }

  private currentBatchMessages() {
    const fromSequence = validSequence(this.options.captureSequence);
    const throughSequence = validSequence(this.options.contextThroughSequence);
    if (fromSequence == null || throughSequence == null) return [];
    const record = this.host.conversationRecords.get(conversationRecordId(this.incoming));
    if (!record) return [];
    const seenIds = new Set<string>();
    return record.messages
      .filter((message) => message.role === "user")
      .filter((message) => {
        const sequence = validSequence(message.sequence);
        return sequence != null && sequence >= fromSequence && sequence <= throughSequence;
      })
      .filter((message) => (
        !this.senderOnlyGroupBatch || message.userId === this.incoming.userId
      ))
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .filter((message) => {
        if (seenIds.has(message.id)) return false;
        seenIds.add(message.id);
        return true;
      });
  }
}

function validSequence(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
