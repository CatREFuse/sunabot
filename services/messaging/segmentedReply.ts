export const MAX_SEGMENTED_REPLY_BUBBLES = 32;
export const MAX_SEGMENTED_REPLY_XML_BYTES = 64 * 1024;

export type SegmentedReplyNodeV1 =
  | { type: "dialog"; text: string; reply: boolean }
  | { type: "expression"; marker: string }
  | { type: "image" | "voice" | "file"; src: string };

export interface SegmentedReplyPackageV1 {
  schemaVersion: 1;
  nodes: SegmentedReplyNodeV1[];
}

export function parseSegmentedReplyXml(value: string): SegmentedReplyPackageV1 {
  if (Buffer.byteLength(value, "utf8") > MAX_SEGMENTED_REPLY_XML_BYTES) {
    throw segmentedReplyError("分段回复 XML 超过大小限制。");
  }
  const nodes: SegmentedReplyNodeV1[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    cursor = skipWhitespace(value, cursor);
    if (cursor >= value.length) break;
    if (value[cursor] !== "<") throw segmentedReplyError("分段回复 XML 含有标签外文本。");
    const opening = readOpeningTag(value, cursor);
    cursor = opening.end;
    if (opening.selfClosing) {
      if (opening.name !== "img" && opening.name !== "voice" && opening.name !== "file") {
        throw segmentedReplyError(`分段回复不支持自闭合标签 <${opening.name}/>。`);
      }
      const attributes = parseAttributes(opening.attributes);
      if (attributes.size !== 1 || !attributes.has("src")) {
        throw segmentedReplyError(`<${opening.name}/> 只能包含 src 属性。`);
      }
      const src = decodeXmlText(attributes.get("src")!).trim();
      if (!src || src.length > 2_048 || hasControlCharacter(src)) {
        throw segmentedReplyError(`<${opening.name}/> 的 src 无效。`);
      }
      nodes.push({ type: opening.name === "img" ? "image" : opening.name, src });
    } else {
      if (opening.name !== "dialog" && opening.name !== "dialogc" && opening.name !== "exp") {
        throw segmentedReplyError(`分段回复不支持标签 <${opening.name}>。`);
      }
      const closeTag = `</${opening.name}>`;
      const closeAt = value.indexOf(closeTag, cursor);
      if (closeAt < 0) throw segmentedReplyError(`<${opening.name}> 缺少闭合标签。`);
      const rawContent = value.slice(cursor, closeAt);
      if (rawContent.includes("<")) throw segmentedReplyError("分段回复节点不能嵌套标签。");
      cursor = closeAt + closeTag.length;
      const attributes = parseAttributes(opening.attributes);
      const content = decodeXmlText(rawContent).trim();
      if (!content || hasControlCharacter(content)) {
        throw segmentedReplyError(`<${opening.name}> 内容无效。`);
      }
      if (opening.name === "exp") {
        if (attributes.size || !/^\[\/[^\]\r\n]{1,64}\]$/u.test(content)) {
          throw segmentedReplyError("<exp> 必须只包含一个表情标记。");
        }
        nodes.push({ type: "expression", marker: content });
      } else {
        const reply = opening.name === "dialogc";
        if (reply) {
          if (attributes.size !== 1 || attributes.get("replay") !== "msg_id") {
            throw segmentedReplyError('<dialogc> 必须且只能包含 replay="msg_id"。');
          }
          if (nodes.length !== 0 || nodes.some((node) => node.type === "dialog" && node.reply)) {
            throw segmentedReplyError("只有第一个气泡可以使用 <dialogc>。");
          }
        } else if (attributes.size) {
          throw segmentedReplyError("<dialog> 不接受属性。");
        }
        nodes.push({ type: "dialog", text: content, reply });
      }
    }
    if (nodes.length > MAX_SEGMENTED_REPLY_BUBBLES) {
      throw segmentedReplyError(`分段回复最多包含 ${MAX_SEGMENTED_REPLY_BUBBLES} 个气泡。`);
    }
  }
  if (!nodes.length) throw segmentedReplyError("分段回复 XML 没有可发送节点。");
  return { schemaVersion: 1, nodes };
}

function readOpeningTag(value: string, start: number) {
  let quote = "";
  let end = -1;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      end = index;
      break;
    }
  }
  if (end < 0 || quote) throw segmentedReplyError("分段回复 XML 起始标签无效。");
  const body = value.slice(start + 1, end).trim();
  if (!body || body.startsWith("/") || body.startsWith("!") || body.startsWith("?")) {
    throw segmentedReplyError("分段回复 XML 起始标签无效。");
  }
  const selfClosing = body.endsWith("/");
  const normalized = selfClosing ? body.slice(0, -1).trimEnd() : body;
  const nameMatch = normalized.match(/^([a-z]+)(?:\s|$)/u);
  if (!nameMatch) throw segmentedReplyError("分段回复 XML 标签名无效。");
  return {
    name: nameMatch[1]!,
    attributes: normalized.slice(nameMatch[0].length).trim(),
    selfClosing,
    end: end + 1
  };
}

function parseAttributes(value: string) {
  const attributes = new Map<string, string>();
  let cursor = 0;
  while (cursor < value.length) {
    cursor = skipWhitespace(value, cursor);
    if (cursor >= value.length) break;
    const match = value.slice(cursor).match(/^([a-z]+)\s*=\s*(["'])(.*?)\2/u);
    if (!match) throw segmentedReplyError("分段回复 XML 属性无效。");
    const name = match[1]!;
    if (attributes.has(name)) throw segmentedReplyError(`分段回复 XML 属性 ${name} 重复。`);
    attributes.set(name, match[3]!);
    cursor += match[0].length;
    if (cursor < value.length && !/\s/u.test(value[cursor]!)) {
      throw segmentedReplyError("分段回复 XML 属性之间缺少空格。");
    }
  }
  return attributes;
}

function decodeXmlText(value: string) {
  let decoded = "";
  let cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf("&", cursor);
    if (ampersand < 0) return decoded + value.slice(cursor);
    decoded += value.slice(cursor, ampersand);
    const semicolon = value.indexOf(";", ampersand + 1);
    if (semicolon < 0 || semicolon - ampersand > 33) {
      throw segmentedReplyError("分段回复 XML 包含未转义的 &。");
    }
    const entity = value.slice(ampersand + 1, semicolon);
    const normalized = entity.toLowerCase();
    if (normalized === "amp") decoded += "&";
    else if (normalized === "lt") decoded += "<";
    else if (normalized === "gt") decoded += ">";
    else if (normalized === "quot") decoded += '"';
    else if (normalized === "apos") decoded += "'";
    else if (/^#(?:x[0-9a-f]+|\d+)$/iu.test(entity)) {
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw segmentedReplyError("分段回复 XML 实体无效。");
      }
      decoded += String.fromCodePoint(codePoint);
    } else {
      throw segmentedReplyError("分段回复 XML 包含未知实体。");
    }
    cursor = semicolon + 1;
  }
  return decoded;
}

function skipWhitespace(value: string, start: number) {
  let cursor = start;
  while (cursor < value.length && /\s/u.test(value[cursor]!)) cursor += 1;
  return cursor;
}

function hasControlCharacter(value: string) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function segmentedReplyError(message: string) {
  return Object.assign(new Error(message), { code: "SEGMENTED_REPLY_XML_INVALID" });
}
