import type { CacheStore } from "../../services/media/attachments/cache.js";
import { chatMediaPublisher } from "../../adapters/filesystem/chatMediaPublisher.js";
import {
  ChatMediaExportService,
  type ChatMediaBoundSource
} from "../../services/media/chatMediaExport.js";
import { isAdminSender, isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import type {
  ChatMediaToolPort,
  ExportChatMediaInput,
  ImportChatEmojiInput,
  ImportChatSelfieInput
} from "../../services/tools/chatMediaTool.js";
import { generateImgMediaHandle } from "../../services/tools/generateImgTool.js";
import { EmojiLibraryRepository, MAX_EMOJI_UPLOAD_BYTES } from "../admin/emojiLibrary.js";
import {
  MAX_SELFIE_REFERENCE_BYTES,
  SelfieReferenceRepository
} from "../admin/selfieReferences.js";
import { resolveProjectPath } from "../config.js";
import type { AppConfig, ParsedIncomingMessage } from "../types.js";
import { fileTypeFromBuffer } from "file-type";
import crypto from "node:crypto";
import {
  resolveConversationWorkbench,
  type ConversationCapabilityContextV1
} from "../../services/conversations/conversationCapability.js";

export function providerChatMediaForIncoming(
  config: AppConfig,
  incoming: ParsedIncomingMessage,
  promptOverride: string | undefined,
  cache: CacheStore,
  isCurrent: () => boolean = () => true,
  capability?: Readonly<ConversationCapabilityContextV1>
): ChatMediaToolPort | undefined {
  if (!isEligibleOneBotTurn(config, incoming, promptOverride)) return undefined;
  const sources = currentAndQuotedMediaSources(incoming);
  if (!sources.size) return undefined;
  const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!agentWorkspace) return undefined;
  const backend = capability
    ? resolveConversationWorkbench(capability, "chat_media_export").primaryBackend
    : incoming.scope === "private"
      ? "native" as const
      : "docker" as const;
  const exporter = new ChatMediaExportService({
    agentWorkspace,
    cache,
    sources,
    publisher: chatMediaPublisher,
    isCurrent,
    backend
  });
  const emojiImportAllowed = isAdminSender(incoming.userId, config.bot.adminQq.trim());
  return Object.freeze({
    export: (input: ExportChatMediaInput) => exporter.export(input),
    freezeCodexInputs: (handles: readonly string[], jobDir: string) => (
      exporter.freezeCodexInputs(handles, jobDir)
    ),
    ...(emojiImportAllowed
      ? {
          importEmoji: async (input: ImportChatEmojiInput) => {
            if (!isCurrent()) throw new Error("CHAT_MEDIA_TURN_EXPIRED");
            const repository = new EmojiLibraryRepository({ getConfig: () => config, backend });
            const before = await repository.list();
            const bytes = await exporter.readImage(input.handle, MAX_EMOJI_UPLOAD_BYTES);
            if (!isCurrent()) throw new Error("CHAT_MEDIA_TURN_EXPIRED");
            const after = await repository.importBytes(input.key, bytes);
            const imported = after.emojis.find((emoji) => emoji.key === input.key);
            if (!imported) throw new Error("CHAT_EMOJI_IMPORT_FAILED");
            const previous = before.emojis.find((emoji) => emoji.key === input.key);
            const match = imported.fileName.match(/^emoji-([a-f0-9]{64})\.(?:png|gif)$/);
            if (!match) throw new Error("CHAT_EMOJI_IMPORT_FAILED");
            return {
              ok: true as const,
              key: imported.key,
              fileName: imported.fileName,
              sha256: match[1]!,
              byteLength: imported.sizeBytes,
              width: imported.width,
              height: imported.height,
              deduplicated: previous?.fileName === imported.fileName
            };
          },
          importSelfie: async (input: ImportChatSelfieInput) => {
            if (!isCurrent()) throw new Error("CHAT_MEDIA_TURN_EXPIRED");
            const bytes = await exporter.readImage(input.handle, MAX_SELFIE_REFERENCE_BYTES);
            const detected = await fileTypeFromBuffer(bytes);
            const extension = selfieExtension(detected?.mime);
            if (!extension) throw new Error("CHAT_SELFIE_IMPORT_TYPE_INVALID");
            if (!isCurrent()) throw new Error("CHAT_MEDIA_TURN_EXPIRED");
            const repository = new SelfieReferenceRepository({ getConfig: () => config, backend });
            const before = await repository.list();
            const id = crypto.createHash("sha256").update(bytes).digest("hex");
            const after = await repository.create({
              fileName: `chat-selfie.${extension}`,
              dataBase64: bytes.toString("base64"),
              note: input.note
            });
            const imported = after.images.find((image) => image.id === id);
            if (!imported) throw new Error("CHAT_SELFIE_IMPORT_FAILED");
            return {
              ok: true as const,
              id: imported.id,
              fileName: imported.fileName,
              note: imported.note,
              byteLength: imported.sizeBytes,
              width: imported.width,
              height: imported.height,
              deduplicated: before.images.some((image) => image.id === imported.id)
            };
          }
        }
      : {})
  });
}

function selfieExtension(mimeType: string | undefined) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return undefined;
}

export function currentAndQuotedMediaSources(incoming: ParsedIncomingMessage) {
  const sources = new Map<string, ChatMediaBoundSource>();
  if (Number.isSafeInteger(incoming.messageId) && Number(incoming.messageId) > 0) {
    addMessageSources(
      sources,
      Number(incoming.messageId),
      incoming.media,
      incoming.attachments
    );
  }
  for (const quote of incoming.quoteReferences.slice(0, 2)) {
    addMessageSources(
      sources,
      quote.messageId,
      quote.media ?? [],
      quote.attachments ?? []
    );
  }
  return sources;
}

function addMessageSources(
  sources: Map<string, ChatMediaBoundSource>,
  messageId: number,
  media: ParsedIncomingMessage["media"],
  attachments: ParsedIncomingMessage["attachments"]
) {
  for (const [index, asset] of media.slice(0, 4).entries()) {
    const handle = generateImgMediaHandle(String(messageId), index);
    if (!sources.has(handle)) sources.set(handle, { kind: "image", asset });
  }
  for (const [index, attachment] of attachments.slice(0, 4).entries()) {
    const handle = `message:${messageId}:file:${index}`;
    if (!sources.has(handle)) sources.set(handle, { kind: "file", attachment });
  }
}

function isEligibleOneBotTurn(
  config: AppConfig,
  incoming: ParsedIncomingMessage,
  promptOverride: string | undefined
) {
  const privateConversation = incoming.scope === "private" && incoming.groupId === undefined;
  const groupConversation = (incoming.scope === "user_group" || incoming.scope === "bot_group")
    && Number.isSafeInteger(incoming.groupId)
    && Number(incoming.groupId) > 0;
  return promptOverride === undefined
    && incoming.transport === undefined
    && incoming.agentId === config.persona.defaultAgentId
    && Boolean(incoming.accountId?.trim())
    && Number.isSafeInteger(incoming.messageId)
    && Number(incoming.messageId) > 0
    && Number.isSafeInteger(incoming.selfId)
    && Number(incoming.selfId) > 0
    && incoming.sender.id === String(incoming.userId)
    && isReplySenderAllowed(incoming.userId)
    && (privateConversation || groupConversation);
}
