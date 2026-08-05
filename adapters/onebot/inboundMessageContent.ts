import type { OneBotMessageSegment } from "./protocol.js";

const MAX_MESSAGE_DEPTH = 4;
const MAX_MESSAGE_SEGMENTS = 512;
const MAX_FORWARD_RECORDS = 100;
const MAX_FORWARD_IDS = 8;
const MAX_RENDERED_TEXT_CHARACTERS = 32_000;
const MAX_CARD_SUMMARY_CHARACTERS = 240;
const MAX_CARD_TREE_DEPTH = 5;
const MAX_CARD_TREE_NODES = 256;
const MAX_CARD_FIELDS = 12;

const CARD_TITLE_KEYS = new Set(["prompt", "title"]);
const CARD_DESCRIPTION_KEYS = new Set(["brief", "content", "desc", "description", "summary", "text"]);
const CARD_ACTION_KEYS = new Set(["actiontext", "buttontext", "label", "tag"]);
const CARD_GROUP_NAME_KEYS = new Set(["groupname", "groupnickname"]);
const CARD_GROUP_ID_KEYS = new Set(["groupcode", "groupid", "groupnum", "groupnumber", "quncode"]);
const CARD_LINK_KEYS = new Set(["actiondata", "jumpurl", "url"]);
const CARD_NESTED_JSON_KEYS = new Set(["content", "data", "extra"]);

export interface RenderedOneBotMessage {
  text: string;
  imageUrls: string[];
}

export interface OneBotMessageRenderOptions {
  selfId?: number;
  forwardPayloads?: ReadonlyMap<string, unknown>;
}

interface RenderState {
  readonly options: OneBotMessageRenderOptions;
  readonly imageUrls: string[];
  imageIndex: number;
  segmentCount: number;
  truncated: boolean;
}

export function renderOneBotMessage(
  message: string | OneBotMessageSegment[],
  options: OneBotMessageRenderOptions = {}
): RenderedOneBotMessage {
  const state: RenderState = {
    options,
    imageUrls: [],
    imageIndex: 0,
    segmentCount: 0,
    truncated: false
  };
  const text = renderMessage(message, state, 0);
  return {
    text: boundedRenderedText(text, state.truncated),
    imageUrls: uniqueStrings(state.imageUrls)
  };
}

export function extractOneBotForwardMessageIds(message: string | OneBotMessageSegment[]) {
  const ids: string[] = [];
  collectForwardIds(readMessage(message), ids, 0, { segments: 0 });
  return uniqueStrings(ids).slice(0, MAX_FORWARD_IDS);
}

function renderMessage(
  message: string | OneBotMessageSegment[],
  state: RenderState,
  depth: number
): string {
  if (depth > MAX_MESSAGE_DEPTH) {
    state.truncated = true;
    return "[嵌套消息已截断]";
  }
  if (Array.isArray(message) && message.length > MAX_MESSAGE_SEGMENTS) state.truncated = true;
  const segments = readMessage(message);
  if (typeof segments === "string") return renderCqMessage(segments, state, depth);
  const parts: string[] = [];
  for (const segment of segments) {
    if (state.segmentCount >= MAX_MESSAGE_SEGMENTS) {
      state.truncated = true;
      break;
    }
    state.segmentCount += 1;
    parts.push(renderSegment(segment, state, depth));
  }
  return parts.join("").trim();
}

function renderCqMessage(message: string, state: RenderState, depth: number) {
  const parts: string[] = [];
  const expression = /\[CQ:([A-Za-z0-9_]+)(?:,([^\]]*))?\]/g;
  let cursor = 0;
  for (const match of message.matchAll(expression)) {
    if (state.segmentCount >= MAX_MESSAGE_SEGMENTS) {
      state.truncated = true;
      cursor = match.index ?? cursor;
      break;
    }
    const index = match.index ?? cursor;
    parts.push(message.slice(cursor, index));
    state.segmentCount += 1;
    parts.push(renderSegment({
      type: String(match[1] ?? ""),
      data: parseCqParams(String(match[2] ?? ""))
    }, state, depth));
    cursor = index + match[0].length;
  }
  if (!state.truncated) parts.push(message.slice(cursor));
  return parts.join("").trim();
}

function renderSegment(segment: OneBotMessageSegment, state: RenderState, depth: number): string {
  const type = String(segment.type ?? "").trim().toLowerCase();
  const data = record(segment.data);
  if (type === "text") return String(data.text ?? "");
  if (type === "at") return renderAt(data, state.options.selfId);
  if (type === "image") return token(renderImage(data, state));
  if (type === "face") return token(`QQ表情${descriptionSuffix(data.summary ?? data.name ?? data.id)}`);
  if (type === "mface") return token(`商城表情${descriptionSuffix(data.summary ?? data.name ?? data.key ?? data.emoji_id)}`);
  if (type === "record") return token(`语音${descriptionSuffix(data.text ?? data.name ?? data.file)}`);
  if (type === "video") return token(`视频${descriptionSuffix(data.name ?? data.file_name ?? data.file)}`);
  if (type === "rps") return token(`猜拳表情${descriptionSuffix(rpsResult(data.result))}`);
  if (type === "dice") return token(`骰子表情${descriptionSuffix(data.result)}`);
  if (type === "shake") return token("窗口抖动");
  if (type === "poke") return token(`戳一戳${descriptionSuffix(data.name ?? data.type)}`);
  if (type === "reply") return token(`回复消息${identifierSuffix(data.id ?? data.message_id)}`);
  if (type === "file") return token(`文件${descriptionSuffix(data.name ?? data.file_name ?? data.file)}`);
  if (type === "onlinefile" || type === "online_file") {
    const name = data.fileName ?? data.file_name ?? data.name ?? data.file;
    return token(`${data.isDir ? "在线文件夹" : "在线文件"}${descriptionSuffix(name ?? data.msgId)}`);
  }
  if (type === "flashtransfer" || type === "flash_transfer") {
    return token(`闪传文件${descriptionSuffix(data.fileSetId ?? data.file_set_id ?? data.name ?? data.summary)}`);
  }
  if (type === "contact") return token(renderContact(data));
  if (type === "location") return token(renderLocation(data));
  if (type === "music") return token(renderMusic(data));
  if (type === "share") return token(`链接分享${descriptionSuffix(data.title ?? data.content ?? data.url)}`);
  if (type === "json") return token(`JSON卡片${descriptionSuffix(cardSummary(data.data ?? data.json ?? data))}`);
  if (type === "xml") return token(`XML卡片${descriptionSuffix(cardSummary(data.data ?? data.xml ?? data))}`);
  if (type === "lightapp" || type === "miniapp") {
    return token(`小程序${descriptionSuffix(cardSummary(data.data ?? data.content ?? data))}`);
  }
  if (type === "markdown") {
    const content = boundedMultiline(data.content ?? data.markdown ?? data.text, 4_000);
    return content ? `\n[Markdown消息]\n${content}\n[/Markdown消息]\n` : token("Markdown消息");
  }
  if (type === "forward") return renderForward(data, state, depth + 1);
  if (type === "node") return renderForwardEntry(data, state, depth + 1, 1);
  if (type === "mix" || type === "mixed" || type === "mix_type") {
    const nested = readMessage(data.content ?? data.message ?? []);
    return nested ? renderMessage(nested, state, depth + 1) : token("混合消息");
  }
  if (type === "data") return token(`数据消息${descriptionSuffix(cardSummary(data.data ?? data.content ?? data))}`);
  if (type === "anonymous") return token("匿名消息");
  return token(`未知消息类型${identifierSuffix(type || "unknown")}`);
}

function renderImage(data: Record<string, unknown>, state: RenderState) {
  const expression = isExpressionImage(data);
  const url = usableImageUrl(data.url) ?? usableImageUrl(data.file);
  let imageNumber: number | undefined;
  if (url) {
    const existingIndex = state.imageUrls.indexOf(url);
    if (existingIndex >= 0) {
      imageNumber = existingIndex + 1;
    } else {
      state.imageUrls.push(url);
      state.imageIndex += 1;
      imageNumber = state.imageIndex;
    }
  }
  const summary = oneLine(data.summary ?? data.name, MAX_CARD_SUMMARY_CHARACTERS);
  const type = expression ? "表情图片" : "内容图片";
  return `${type}${imageNumber ? `#${imageNumber}` : ""}${summary ? `：${summary}` : ""}`;
}

function renderAt(data: Record<string, unknown>, selfId?: number) {
  const qq = oneLine(data.qq ?? data.user_id, 64);
  if (!qq) return token("@用户");
  if (qq === "all") return "@全体成员";
  if (selfId && qq === String(selfId)) return "";
  const name = oneLine(data.name, 80);
  return `@${name || qq}`;
}

function renderForward(data: Record<string, unknown>, state: RenderState, depth: number) {
  const id = oneLine(data.id ?? data.message_id, 256);
  const inline = forwardEntries(data.content ?? data.messages);
  const resolved = id ? forwardEntries(state.options.forwardPayloads?.get(id)) : [];
  const entries = inline.length ? inline : resolved;
  if (!entries.length) return token(`聊天记录${id ? `：ID ${id}，内容暂不可用` : "：内容暂不可用"}`);
  const rendered = entries.slice(0, MAX_FORWARD_RECORDS).map((entry, index) => (
    renderForwardEntry(entry, state, depth, index + 1)
  ));
  if (entries.length > MAX_FORWARD_RECORDS) {
    state.truncated = true;
    rendered.push("[聊天记录其余内容已截断]");
  }
  return `\n[聊天记录开始${id ? `：${safeMarkerText(id)}` : ""}]\n${rendered.join("\n")}\n[聊天记录结束]\n`;
}

function renderForwardEntry(value: unknown, state: RenderState, depth: number, index: number) {
  const entry = record(value);
  const data = record(entry.data);
  const sender = record(entry.sender);
  const rawContent = entry.message ?? entry.content ?? data.content ?? data.message ?? entry.raw_message ?? "";
  if (Array.isArray(rawContent) && rawContent.length > MAX_MESSAGE_SEGMENTS) state.truncated = true;
  const content = readMessage(rawContent);
  const senderName = oneLine(
    sender.card ?? sender.nickname ?? entry.nickname ?? data.nickname ?? entry.name ?? data.name,
    120
  ) || "未知发送者";
  const senderId = oneLine(sender.user_id ?? entry.user_id ?? data.user_id ?? data.uin, 64);
  const senderLabel = senderId ? `${senderName}(QQ ${senderId})` : senderName;
  const body = content ? escapeForwardBoundaryMarkers(renderMessage(content, state, depth)) : "[空消息]";
  return `${index}. ${senderLabel}：${body}`;
}

function escapeForwardBoundaryMarkers(value: string) {
  return value
    .replaceAll("[聊天记录开始", "［聊天记录开始")
    .replaceAll("[聊天记录结束]", "［聊天记录结束］");
}

function renderContact(data: Record<string, unknown>) {
  const type = oneLine(data.type, 32);
  const id = oneLine(data.id ?? data.user_id ?? data.group_id, 64);
  const label = type === "group" ? "推荐群聊" : type === "qq" ? "推荐联系人" : "联系人分享";
  return `${label}${id ? `：${id}` : ""}`;
}

function renderLocation(data: Record<string, unknown>) {
  const name = oneLine(data.title ?? data.content, 160);
  const latitude = oneLine(data.lat ?? data.latitude, 32);
  const longitude = oneLine(data.lon ?? data.longitude, 32);
  const coordinates = latitude && longitude ? `${latitude},${longitude}` : "";
  return `位置${descriptionSuffix(name || coordinates)}`;
}

function renderMusic(data: Record<string, unknown>) {
  const title = oneLine(data.title ?? data.name ?? data.id, 160);
  const artist = oneLine(data.singer ?? data.artist ?? data.content, 120);
  return `音乐${descriptionSuffix([title, artist].filter(Boolean).join(" - "))}`;
}

function rpsResult(value: unknown) {
  const result = oneLine(value, 16);
  if (result === "1") return "石头";
  if (result === "2") return "剪刀";
  if (result === "3") return "布";
  return result;
}

function isExpressionImage(data: Record<string, unknown>) {
  const subType = Number(data.sub_type ?? data.subType);
  const file = oneLine(data.file, 128).toLowerCase();
  return subType === 1 || file === "marketface" || Boolean(
    data.emoji_id ?? data.emoji_package_id ?? data.emojiId ?? data.emojiPackageId
  );
}

function collectForwardIds(
  message: string | OneBotMessageSegment[],
  output: string[],
  depth: number,
  state: { segments: number }
) {
  if (depth > MAX_MESSAGE_DEPTH
    || output.length >= MAX_FORWARD_IDS
    || state.segments >= MAX_MESSAGE_SEGMENTS) return;
  if (typeof message === "string") {
    for (const match of message.matchAll(/\[CQ:forward,([^\]]+)\]/g)) {
      const id = oneLine(parseCqParams(String(match[1] ?? "")).id, 256);
      if (id) output.push(id);
      if (output.length >= MAX_FORWARD_IDS) return;
    }
    return;
  }
  for (const segment of message) {
    if (state.segments >= MAX_MESSAGE_SEGMENTS) return;
    state.segments += 1;
    const type = String(segment.type ?? "").toLowerCase();
    const data = record(segment.data);
    if (type === "forward") {
      const id = oneLine(data.id ?? data.message_id, 256);
      if (id && !forwardEntries(data.content ?? data.messages).length) output.push(id);
      for (const entry of forwardEntries(data.content ?? data.messages)) {
        const recordEntry = record(entry);
        const nested = readMessage(recordEntry.message ?? recordEntry.content ?? record(recordEntry.data).content ?? "");
        if (nested) collectForwardIds(nested, output, depth + 1, state);
      }
    } else if (type === "node" || type === "mix" || type === "mixed" || type === "mix_type") {
      const nested = readMessage(data.content ?? data.message ?? "");
      if (nested) collectForwardIds(nested, output, depth + 1, state);
    }
    if (output.length >= MAX_FORWARD_IDS) return;
  }
}

function forwardEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  const data = record(root.data);
  for (const candidate of [data.messages, data.content, data.message, root.messages, root.content, root.message]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function readMessage(value: unknown): string | OneBotMessageSegment[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.slice(0, MAX_MESSAGE_SEGMENTS).flatMap((item) => {
    const segment = record(item);
    return typeof segment.type === "string"
      ? [{ type: segment.type, data: record(segment.data) } satisfies OneBotMessageSegment]
      : [];
  });
}

interface CardField {
  priority: number;
  order: number;
  value: string;
}

function cardSummary(value: unknown) {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!raw) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const fields: CardField[] = [];
    const state = { nodes: 0, order: 0 };
    const groupCard = cardTreeHasGroupHint(parsed, 0, { nodes: 0 });
    collectCardFields(parsed, fields, groupCard, [], 0, state);
    const summary = uniqueCardFields(fields)
      .slice(0, MAX_CARD_FIELDS)
      .map((field) => field.value)
      .join("；");
    return oneLine(summary || raw, MAX_CARD_SUMMARY_CHARACTERS);
  } catch {
    return oneLine(raw, MAX_CARD_SUMMARY_CHARACTERS);
  }
}

function collectCardFields(
  value: unknown,
  output: CardField[],
  groupCard: boolean,
  path: string[],
  depth: number,
  state: { nodes: number; order: number }
) {
  if (depth > MAX_CARD_TREE_DEPTH || state.nodes >= MAX_CARD_TREE_NODES) return;
  state.nodes += 1;
  if (Array.isArray(value)) {
    for (const item of value) collectCardFields(item, output, groupCard, path, depth + 1, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (state.nodes >= MAX_CARD_TREE_NODES) return;
    state.nodes += 1;
    const key = normalizedCardKey(rawKey);
    const nextPath = [...path, key];
    const scalar = cardScalar(child);
    if (scalar) {
      const nested = CARD_NESTED_JSON_KEYS.has(key) ? parseNestedCardJson(scalar) : undefined;
      if (CARD_TITLE_KEYS.has(key)) addCardField(output, unwrappedCardTitle(scalar), 10, state);
      else if (CARD_GROUP_NAME_KEYS.has(key)) addCardField(output, `群名：${scalar}`, 20, state);
      else if (CARD_GROUP_ID_KEYS.has(key)) addCardGroupId(output, scalar, state);
      else if (groupCard && ["contact", "nickname"].includes(key)) {
        addCardField(output, `群名：${scalar}`, 20, state);
      } else if (groupCard && key === "uin" && nextPath.includes("extra")) {
        addCardGroupId(output, scalar, state);
      } else if (CARD_DESCRIPTION_KEYS.has(key) && nested === undefined) addCardField(output, scalar, 40, state);
      else if (CARD_ACTION_KEYS.has(key)) addCardField(output, scalar, 50, state);
      if (groupCard && CARD_LINK_KEYS.has(key)) {
        for (const groupId of groupIdsFromCardLink(scalar)) {
          addCardGroupId(output, groupId, state);
        }
      }
      if (nested !== undefined) collectCardFields(nested, output, groupCard, nextPath, depth + 1, state);
    } else {
      collectCardFields(child, output, groupCard, nextPath, depth + 1, state);
    }
  }
}

function cardTreeHasGroupHint(value: unknown, depth: number, state: { nodes: number }): boolean {
  if (depth > MAX_CARD_TREE_DEPTH || state.nodes >= MAX_CARD_TREE_NODES) return false;
  state.nodes += 1;
  if (Array.isArray(value)) {
    return value.some((item) => cardTreeHasGroupHint(item, depth + 1, state));
  }
  if (!value || typeof value !== "object") return false;
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (state.nodes >= MAX_CARD_TREE_NODES) return false;
    state.nodes += 1;
    const key = normalizedCardKey(rawKey);
    if (key.includes("group") || key.includes("qun")) return true;
    const scalar = cardScalar(child);
    if (scalar && /群聊|群名片|邀请加群|card_type=group/i.test(scalar)) return true;
    if (scalar && CARD_NESTED_JSON_KEYS.has(key)) {
      const nested = parseNestedCardJson(scalar);
      if (nested !== undefined && cardTreeHasGroupHint(nested, depth + 1, state)) return true;
    } else if (!scalar && cardTreeHasGroupHint(child, depth + 1, state)) {
      return true;
    }
  }
  return false;
}

function addCardField(output: CardField[], value: string, priority: number, state: { order: number }) {
  const text = oneLine(value, MAX_CARD_SUMMARY_CHARACTERS);
  const unlabelled = text.replace(/^(?:群名|群号)：/, "");
  if (!text || looksLikeCardTransport(unlabelled)) return;
  output.push({ priority, order: state.order, value: text });
  state.order += 1;
}

function addCardGroupId(output: CardField[], value: string, state: { order: number }) {
  const identifier = oneLine(value, 32);
  if (/^[1-9]\d{0,31}$/.test(identifier)) addCardField(output, `群号：${identifier}`, 30, state);
}

function uniqueCardFields(fields: CardField[]) {
  const result: CardField[] = [];
  const indexes = new Map<string, number>();
  for (const field of fields.sort((left, right) => left.priority - right.priority || left.order - right.order)) {
    const key = cardFieldDedupeKey(field.value);
    if (!key) continue;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, result.length);
      result.push(field);
    } else if (hasCardFieldLabel(field.value) && !hasCardFieldLabel(result[existingIndex]!.value)) {
      result[existingIndex] = field;
    }
  }
  return result.sort((left, right) => left.priority - right.priority || left.order - right.order);
}

function cardFieldDedupeKey(value: string) {
  return value
    .replace(/^(?:群名|群号)：/, "")
    .replace(/^[\[【](.*)[\]】]$/, "$1")
    .trim();
}

function hasCardFieldLabel(value: string) {
  return /^(?:群名|群号)：/.test(value);
}

function groupIdsFromCardLink(value: string) {
  try {
    const url = new URL(value);
    const ids: string[] = [];
    for (const [rawKey, rawValue] of url.searchParams) {
      const key = normalizedCardKey(rawKey);
      if (CARD_GROUP_ID_KEYS.has(key) || key === "uin") {
        const id = oneLine(rawValue, 64);
        if (id) ids.push(id);
      }
    }
    return uniqueStrings(ids);
  } catch {
    return [];
  }
}

function parseNestedCardJson(value: string): unknown | undefined {
  const text = value.trim();
  if (!(text.startsWith("{") && text.endsWith("}"))
    && !(text.startsWith("[") && text.endsWith("]"))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizedCardKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function unwrappedCardTitle(value: string) {
  const match = value.match(/^[\[【](.*)[\]】]$/);
  return match?.[1]?.trim() || value;
}

function cardScalar(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? oneLine(value, MAX_CARD_SUMMARY_CHARACTERS)
    : "";
}

function looksLikeCardTransport(value: string) {
  return /^(?:https?:\/\/|mqqapi:\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value);
}

function parseCqParams(input: string) {
  const params: Record<string, string> = {};
  for (const part of input.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (key) params[key] = decodeCqValue(part.slice(separator + 1));
  }
  return params;
}

function decodeCqValue(value: string) {
  return value
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
}

function boundedRenderedText(value: string, truncated: boolean) {
  const characters = [...value.trim()];
  const suffix = truncated || characters.length > MAX_RENDERED_TEXT_CHARACTERS
    ? "\n[消息内容已截断]"
    : "";
  const budget = Math.max(0, MAX_RENDERED_TEXT_CHARACTERS - [...suffix].length);
  const text = characters.slice(0, budget).join("");
  return `${text}${suffix}`.trim();
}

function boundedMultiline(value: unknown, limit: number) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return [...text].slice(0, limit).join("");
}

function oneLine(value: unknown, limit: number) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return [...text].slice(0, limit).join("");
}

function descriptionSuffix(value: unknown) {
  const description = oneLine(value, MAX_CARD_SUMMARY_CHARACTERS);
  return description ? `：${description}` : "";
}

function identifierSuffix(value: unknown) {
  const identifier = oneLine(value, 256);
  return identifier ? `：${identifier}` : "";
}

function token(value: string) {
  return ` [${safeMarkerText(value)}] `;
}

function safeMarkerText(value: string) {
  return value.replaceAll("[", "［").replaceAll("]", "］");
}

function usableImageUrl(value: unknown) {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) return undefined;
  return /^https?:\/\//i.test(url) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(url)
    ? url
    : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
