import type { OutboundContentSegmentV1 } from "../messaging/messages.js";

export function decodeReplyContentSegmentsV1(
  value: unknown,
  text: unknown,
  generatedImages: unknown
): OutboundContentSegmentV1[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || !Array.isArray(generatedImages)) {
    throw invalidContentSegments();
  }
  const segments: OutboundContentSegmentV1[] = [];
  const imageIndexes = new Set<number>();
  let joinedText = "";
  for (const item of value) {
    if (!isRecord(item)) throw invalidContentSegments();
    const keys = Object.keys(item).sort().join(",");
    if (item.type === "text") {
      if (keys !== "text,type" || typeof item.text !== "string" || !item.text
        || segments.at(-1)?.type === "text") {
        throw invalidContentSegments();
      }
      segments.push({ type: "text", text: item.text });
      joinedText += item.text;
      continue;
    }
    if ((item.type !== "image" && item.type !== "sticker") || keys !== "imageIndex,type"
      || !Number.isSafeInteger(item.imageIndex)
      || Number(item.imageIndex) < 0
      || Number(item.imageIndex) >= generatedImages.length
      || imageIndexes.has(Number(item.imageIndex))) {
      throw invalidContentSegments();
    }
    const imageIndex = Number(item.imageIndex);
    imageIndexes.add(imageIndex);
    segments.push({ type: item.type, imageIndex });
  }
  if (joinedText !== text || imageIndexes.size !== generatedImages.length) throw invalidContentSegments();
  return segments;
}

function invalidContentSegments() {
  return Object.assign(new Error("持久化消息字段 contentSegments 无效。"), {
    code: "contract_field_invalid"
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
