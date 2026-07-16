import { createHash } from "node:crypto";
import type { ParsedAttachment } from "../media/media.js";
import type { InboundMessageV1, MessageQuoteV1 } from "./messages.js";

const INLINE_FINGERPRINT_STRING_LIMIT = 512;

export function inboundMessageIdentityV1(incoming: InboundMessageV1) {
  if (incoming.messageId != null) return `message:${incoming.messageId}`;
  const canonical = {
    schemaVersion: 1,
    transport: incoming.transport ?? "onebot",
    agentId: stableString(incoming.agentId),
    accountId: stableString(incoming.accountId ?? "primary"),
    selfId: incoming.selfId ?? null,
    conversation: {
      id: inboundConversationIdV1(incoming),
      scope: incoming.scope
    },
    sender: {
      id: stableString(incoming.sender.id),
      nickname: stableString(incoming.sender.nickname),
      card: stableString(incoming.sender.card),
      displayName: stableString(incoming.sender.displayName)
    },
    time: stableString(incoming.time),
    text: stableString(incoming.text),
    mentionedSelf: incoming.mentionedSelf,
    media: digestItems(incoming.media, canonicalMedia),
    attachments: digestItems(incoming.attachments, canonicalAttachment),
    replyMessageIds: digestItems(incoming.replyMessageIds, (messageId) => messageId),
    quoteReferences: digestItems(incoming.quoteReferences, canonicalQuote)
  };
  return `content:v1:${sha256(JSON.stringify(canonical))}`;
}

export function inboundConversationIdV1(incoming: InboundMessageV1) {
  if (incoming.transport === "web") return "web:admin";
  const localId = incoming.groupId ? `group:${incoming.groupId}` : `private:${incoming.userId}`;
  return incoming.accountId && incoming.accountId !== "primary"
    ? `account:${incoming.accountId}:${localId}`
    : localId;
}

function canonicalMedia(asset: InboundMessageV1["media"][number]) {
  return {
    schemaVersion: asset.schemaVersion,
    kind: asset.kind,
    source: asset.source,
    url: stableString(asset.url),
    filePath: stableString(asset.filePath)
  };
}

function canonicalAttachment(attachment: ParsedAttachment) {
  return {
    id: stableString(attachment.id),
    source: attachment.source,
    name: stableString(attachment.name),
    fileId: stableString(attachment.fileId),
    sizeBytes: attachment.sizeBytes ?? null,
    busId: attachment.busId ?? null,
    groupId: attachment.groupId ?? null,
    userId: attachment.userId ?? null,
    mimeType: stableString(attachment.mimeType),
    format: stableString(attachment.format),
    sha256: stableString(attachment.sha256)
  };
}

function canonicalQuote(quote: MessageQuoteV1) {
  return {
    messageId: quote.messageId,
    text: stableString(quote.text),
    senderName: stableString(quote.senderName),
    media: digestItems(quote.media ?? [], canonicalMedia),
    imageUrls: digestItems(quote.imageUrls ?? [], stableString),
    attachments: digestItems(quote.attachments ?? [], canonicalAttachment)
  };
}

function digestItems<T, R>(values: readonly T[], map: (value: T) => R) {
  const hash = createHash("sha256");
  values.forEach((value, index) => {
    const encoded = JSON.stringify(map(value));
    hash.update(`${index}:${encoded.length}:`);
    hash.update(encoded);
    hash.update("\n");
  });
  return { count: values.length, sha256: hash.digest("hex") };
}

function stableString(value: string | undefined) {
  if (value == null) return null;
  if (value.length <= INLINE_FINGERPRINT_STRING_LIMIT) return value;
  return { length: value.length, sha256: sha256(value) };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
