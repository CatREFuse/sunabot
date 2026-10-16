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
  const source = value.trim().replace(/^```(?:xml)?\s*\n([\s\S]*)\n```$/iu, "$1");
  const nodes: SegmentedReplyNodeV1[] = [];
  const pattern = /<(dialogc|dialog|exp)\b[^>]*>([\s\S]*?)<\/\1\s*>|<(exp|img|voice|file)\b([^>]*?)\/?>/giu;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(cursor, match.index);
    if (before.trim()) nodes.push({ type: "dialog", text: decodeXmlText(before), reply: false });
    cursor = match.index! + match[0].length;
    const name = (match[1] ?? match[3])!.toLowerCase();
    const content = match[2] == null ? undefined : decodeXmlText(match[2]);
    if (name === "dialog" || name === "dialogc") {
      if (content?.trim()) nodes.push({ type: "dialog", text: content, reply: name === "dialogc" });
      continue;
    }
    const attributeName = name === "exp" ? "key" : "src";
    const attribute = (match[4] ?? "").match(new RegExp(`\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, "iu"));
    const attributeValue = attribute ? decodeXmlText(attribute[1] ?? attribute[2] ?? attribute[3] ?? "").trim() : "";
    const marker = content?.trim() ?? attributeValue;
    if (name === "exp" && /^\[\/[^\]\r\n]+\]$/u.test(marker)) {
      nodes.push({ type: "expression", marker });
    } else if ((name === "img" || name === "voice" || name === "file") && attributeValue) {
      nodes.push({ type: name === "img" ? "image" : name, src: attributeValue });
    } else {
      nodes.push({ type: "dialog", text: match[0], reply: false });
    }
  }
  const remaining = source.slice(cursor);
  if (remaining.trim()) nodes.push({ type: "dialog", text: decodeXmlText(remaining), reply: false });
  if (!nodes.length && source) nodes.push({ type: "dialog", text: source, reply: false });
  return { schemaVersion: 1, nodes };
}

function decodeXmlText(value: string) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (source, entity: string) => {
    const normalized = entity.toLowerCase();
    if (entities[normalized] != null) return entities[normalized]!;
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : source;
  });
}
