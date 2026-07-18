import crypto from "node:crypto";
import type { ImageResult } from "../../packages/contracts/media/media.js";
import type { OutboundContentSegmentV1 } from "../../packages/contracts/messaging/messages.js";

export const PRESET_EMOJI_KEYS = [
  "开心",
  "哭",
  "抓狂",
  "惊慌",
  "害羞",
  "极度害羞",
  "困倦",
  "认真",
  "嫌弃脸",
  "生气",
  "汗颜"
] as const;

export const MAX_AGENT_EMOJIS = 64;
export const MAX_EMOJI_MARKERS_PER_REPLY = 4;
export const EMOJI_MARKER_SYNTAX =
  "需要发送表情时，在正文对应位置输出 [/表情key]。表情key 必须从可用列表中精确选择，不得编造、转义或嵌套；单条回复最多 4 个表情，没有合适表情时不要输出标记。";

export const EMOJI_EXPRESSION_PROMPTS: Readonly<Record<string, string>> = {
  开心: "真诚开心地笑，眼神明亮，嘴角自然上扬",
  哭: "委屈地哭，眼眶含泪，泪珠清晰但不过度夸张",
  抓狂: "快要抓狂，眉眼用力，情绪强烈又可爱",
  惊慌: "突然惊慌，眼睛睁大，嘴巴微张",
  害羞: "轻微害羞，脸颊泛红，视线稍微躲闪",
  极度害羞: "极度害羞，满脸通红，用头侧的黑色羽翼遮住大部分脸",
  困倦: "非常困倦，半闭着眼，像快要睡着",
  认真: "认真专注，目光坚定，表情沉静",
  嫌弃脸: "明显嫌弃，半眯眼，嘴角轻轻下撇",
  生气: "生气鼓脸，眉头皱起，情绪清楚但仍然可爱",
  汗颜: "尴尬汗颜，勉强微笑，额角有一滴冷汗"
};

export interface EmojiMarkerPlan {
  text: string;
  catalog: ReadonlyMap<string, ImageResult>;
  expectedKeys: readonly string[];
  expectedMarkers: readonly string[];
  expectedTextSegments: readonly string[];
  expectedImages: readonly ImageResult[];
}

export interface EmojiToneRewriteGuard {
  input: string;
  plan: EmojiMarkerPlan;
  segmentOpeners: readonly string[];
  segmentClosers: readonly string[];
}

export interface EmojiCatalogEntry {
  key: string;
  image: ImageResult;
}

export interface EmojiCatalogPort {
  listAvailable(): readonly EmojiCatalogEntry[];
}

export interface PreparedEmojiReply {
  text: string;
  images: ImageResult[];
  contentSegments?: OutboundContentSegmentV1[];
}

export function normalizeEmojiKey(value: unknown) {
  return String(value ?? "").trim().normalize("NFC");
}

export function isValidEmojiKey(value: string) {
  const raw = String(value ?? "");
  const key = normalizeEmojiKey(raw);
  return Boolean(
    key
    && [...key].length <= 24
    && Buffer.byteLength(key, "utf8") <= 64
    && !hasInvalidUnicode(raw)
    && !/[\u0000-\u001f\u007f-\u009f\[\]\/\\]/u.test(raw)
  );
}

export function isEmojiFileName(value: string) {
  return /^emoji-[a-f0-9]{64}\.png$/u.test(value);
}

export function planEmojiMarkers(text: string, port: EmojiCatalogPort): EmojiMarkerPlan {
  const entries = port.listAvailable();
  const catalog = new Map(entries.map((entry) => [entry.key, { ...entry.image }] as const));
  const markers = recognizedEmojiMarkers(text, catalog);
  if (markers.length > MAX_EMOJI_MARKERS_PER_REPLY) {
    throw new Error(`单条回复最多 ${MAX_EMOJI_MARKERS_PER_REPLY} 个表情，请减少后重试。`);
  }
  const expectedKeys = markers.map((marker) => marker.key);
  return {
    text,
    catalog,
    expectedKeys,
    expectedMarkers: markers.map((marker) => marker.raw),
    expectedTextSegments: markerTextSegments(text, markers),
    expectedImages: expectedKeys.map((key) => ({ ...catalog.get(key)! }))
  };
}

export function replanEmojiMarkers(text: string, plan: EmojiMarkerPlan) {
  const markers = recognizedEmojiMarkers(text, plan.catalog);
  assertExpectedMarkers(markers, plan);
  return planEmojiMarkersFromCatalog(text, plan.catalog);
}

export function guardEmojiToneRewrite(text: string, plan: EmojiMarkerPlan): EmojiToneRewriteGuard {
  const currentPlan = replanEmojiMarkers(text, plan);
  const token = uniqueToneGuardToken(text);
  const segmentOpeners = currentPlan.expectedTextSegments.map((_, index) => `[/__suna_${token}_${index}_s]`);
  const segmentClosers = currentPlan.expectedTextSegments.map((_, index) => `[/__suna_${token}_${index}_e]`);
  const parts: string[] = [];
  for (let index = 0; index < currentPlan.expectedTextSegments.length; index += 1) {
    parts.push(
      segmentOpeners[index]!,
      currentPlan.expectedTextSegments[index]!,
      segmentClosers[index]!
    );
    const marker = currentPlan.expectedMarkers[index];
    if (marker) parts.push(marker);
  }
  return {
    input: parts.join(""),
    plan: currentPlan,
    segmentOpeners,
    segmentClosers
  };
}

export function restoreEmojiToneRewrite(text: string, guard: EmojiToneRewriteGuard) {
  const segments: string[] = [];
  let cursor = 0;
  for (let index = 0; index < guard.segmentOpeners.length; index += 1) {
    const opener = guard.segmentOpeners[index]!;
    const closer = guard.segmentClosers[index]!;
    if (!text.startsWith(opener, cursor)) throw emojiMarkerChanged();
    cursor += opener.length;
    const closerIndex = text.indexOf(closer, cursor);
    if (closerIndex < 0) throw emojiMarkerChanged();
    segments.push(text.slice(cursor, closerIndex));
    cursor = closerIndex + closer.length;
    const marker = guard.plan.expectedMarkers[index];
    if (marker) {
      if (!text.startsWith(marker, cursor)) throw emojiMarkerChanged();
      cursor += marker.length;
    }
  }
  if (cursor !== text.length) throw emojiMarkerChanged();
  const restored = segments.flatMap((segment, index) => {
    const marker = guard.plan.expectedMarkers[index];
    return marker ? [segment, marker] : [segment];
  }).join("");
  return {
    text: restored,
    plan: replanEmojiMarkers(restored, guard.plan)
  };
}

export function emojiPlanContainsMarkers(plan: EmojiMarkerPlan) {
  return plan.expectedMarkers.length > 0;
}

export function emojiPlanContainsOnlyMarkers(plan: EmojiMarkerPlan) {
  return emojiPlanContainsMarkers(plan) && plan.expectedTextSegments.every((segment) => !segment.trim());
}

export function prepareEmojiReply(
  text: string,
  plan: EmojiMarkerPlan,
  trailingImages: readonly ImageResult[] = []
): PreparedEmojiReply {
  const actualMarkers = recognizedEmojiMarkers(text, plan.catalog);
  assertExpectedMarkers(actualMarkers, plan);
  const actualKeys = actualMarkers.map((marker) => marker.key);
  if (actualKeys.length && !sameStringSequence(markerTextSegments(text, actualMarkers), plan.expectedTextSegments)) {
    throw emojiMarkerChanged();
  }
  if (!actualKeys.length) {
    return { text, images: [...trailingImages] };
  }

  const images: ImageResult[] = [];
  const contentSegments: OutboundContentSegmentV1[] = [];
  let cursor = 0;
  for (const marker of actualMarkers) {
    appendTextPart(contentSegments, text.slice(cursor, marker.index));
    images.push({ ...marker.image });
    contentSegments.push({ type: "image", imageIndex: images.length - 1 });
    cursor = marker.index + marker.raw.length;
  }
  appendTextPart(contentSegments, text.slice(cursor));
  for (const image of trailingImages) {
    images.push({ ...image });
    contentSegments.push({ type: "image", imageIndex: images.length - 1 });
  }
  trimBoundaryTextSegments(contentSegments);
  if (contentSegments.length > 64) throw new Error("单条消息中的表情过多，请减少后重试。");
  return {
    text: contentSegments.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
    images,
    contentSegments
  };
}

export function emojiGenerationPrompt(key: string, agentName: string) {
  const expression = EMOJI_EXPRESSION_PROMPTS[key] ?? `清楚表达“${key}”的情绪`;
  return [
    `为角色“${agentName}”创作一张聊天表情图片。`,
    `表情：${expression}。`,
    "严格保持参考图中的同一人物、发型、发色、眼睛、服装、头部配饰和画风，不改变年龄感。",
    "1:1 方形构图，大头及肩部近景，脸部占画面主体，表情清楚，白色或浅色简洁背景。",
    "画面只出现一个角色，不要文字、标点、边框、水印、徽标、对话框或无关物件。"
  ].join("\n");
}

interface RecognizedEmojiMarker {
  raw: string;
  key: string;
  index: number;
  image: ImageResult;
}

function recognizedEmojiMarkers(text: string, catalog: ReadonlyMap<string, ImageResult>) {
  const markers: RecognizedEmojiMarker[] = [];
  for (const match of text.matchAll(emojiMarkerPattern())) {
    const index = match.index ?? 0;
    if (markerIsEscaped(text, index)) continue;
    const rawKey = match[1] ?? "";
    const key = normalizeEmojiKey(rawKey);
    const image = catalog.get(key);
    if (rawKey !== key || !image) continue;
    markers.push({ raw: match[0], key, index, image });
  }
  return markers;
}

function emojiMarkerPattern() {
  return /\[\/([^\]\r\n]{1,64})\]/gu;
}

function markerIsEscaped(text: string, markerIndex: number) {
  let slashCount = 0;
  for (let index = markerIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function markerTextSegments(text: string, markers: readonly RecognizedEmojiMarker[]) {
  const segments: string[] = [];
  let cursor = 0;
  for (const marker of markers) {
    segments.push(text.slice(cursor, marker.index));
    cursor = marker.index + marker.raw.length;
  }
  segments.push(text.slice(cursor));
  return segments;
}

function sameStringSequence(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExpectedMarkers(markers: readonly RecognizedEmojiMarker[], plan: EmojiMarkerPlan) {
  const keys = markers.map((marker) => marker.key);
  if (keys.length !== plan.expectedKeys.length
    || keys.some((key, index) => key !== plan.expectedKeys[index])
    || markers.some((marker, index) => marker.raw !== plan.expectedMarkers[index])) {
    throw emojiMarkerChanged();
  }
}

function planEmojiMarkersFromCatalog(text: string, catalog: ReadonlyMap<string, ImageResult>) {
  return planEmojiMarkers(text, {
    listAvailable: () => [...catalog].map(([key, image]) => ({ key, image }))
  });
}

function uniqueToneGuardToken(text: string) {
  for (;;) {
    const token = crypto.randomUUID().replaceAll("-", "");
    if (!text.includes(token)) return token;
  }
}

function emojiMarkerChanged() {
  return new Error("语气改写改变了表情标记，请重试。");
}

function hasInvalidUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0xfffd) return true;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function appendTextPart(parts: OutboundContentSegmentV1[], text: string) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") previous.text += text;
  else parts.push({ type: "text", text });
}

function trimBoundaryTextSegments(parts: OutboundContentSegmentV1[]) {
  const firstText = parts.find((part) => part.type === "text");
  if (firstText?.type === "text") firstText.text = firstText.text.trimStart();
  const lastText = [...parts].reverse().find((part) => part.type === "text");
  if (lastText?.type === "text") lastText.text = lastText.text.trimEnd();
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text" && !(parts[index] as { text: string }).text) parts.splice(index, 1);
  }
}
