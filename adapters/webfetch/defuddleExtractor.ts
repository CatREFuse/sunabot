import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { WebFetchError, type ExtractedWebContent } from "../../services/webfetch/public.js";

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_HTML_NODES = 100_000;
const MAX_HTML_DEPTH = 256;

export async function extractWebContent(html: string, url: string): Promise<ExtractedWebContent> {
  try {
    assertHtmlBounds(html);
    const { document } = parseHTML(html);
    assertDomBounds(document);
    const result = await Defuddle(document, url, {
      markdown: true,
      useAsync: false,
      removeHiddenElements: true,
      removeLowScoring: true,
      removeSmallImages: true,
      standardize: true
    });
    const markdown = normalizeMarkdown(String(result.content ?? ""), url);
    if (!markdown) throw new WebFetchError("CONTENT_EXTRACTION_FAILED", "Extractor returned no content.");
    const visible = markdown.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`\[\]()|-]/g, " ").replace(/\s+/g, " ").trim();
    const paragraphCount = markdown.split(/\n\s*\n/).filter((part) => part.trim().length >= 20).length;
    const headingCount = (markdown.match(/^#{1,6}\s+/gm) ?? []).length;
    const linkChars = [...markdown.matchAll(/\[[^\]]*\]\([^)]+\)/g)].reduce((sum, match) => sum + match[0].length, 0);
    const linkDensity = linkChars / Math.max(markdown.length, 1);
    const qualityScore = visible.length + paragraphCount * 80 + headingCount * 30 - linkDensity * 600;
    return {
      title: String(result.title ?? document.title ?? "").trim().slice(0, 500),
      markdown,
      textLength: visible.length,
      paragraphCount,
      headingCount,
      linkDensity,
      qualityScore
    };
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    throw new WebFetchError("CONTENT_EXTRACTION_FAILED", "Extractor failed.");
  }
}

function assertDomBounds(document: unknown) {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: document, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (!current.node || typeof current.node !== "object") continue;
    const children = (current.node as { childNodes?: ArrayLike<unknown> }).childNodes;
    if (!children) continue;
    for (let index = 0; index < children.length; index += 1) {
      nodes += 1;
      if (nodes > MAX_HTML_NODES) {
        throw new WebFetchError("RESPONSE_TOO_LARGE", "HTML node count exceeds the extraction limit.");
      }
      const depth = current.depth + 1;
      if (depth > MAX_HTML_DEPTH) {
        throw new WebFetchError("RESPONSE_TOO_LARGE", "HTML nesting exceeds the extraction limit.");
      }
      stack.push({ node: children[index], depth });
    }
  }
}

function assertHtmlBounds(html: string) {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new WebFetchError("RESPONSE_TOO_LARGE", "HTML exceeds the extraction limit.");
  }
  let nodes = 0;
  let depth = 0;
  let maxDepth = 0;
  const tags = html.match(/<!--(?:[\s\S]*?)-->|<\/?[a-z][^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (tag.startsWith("<!--") || /^<\//u.test(tag)) {
      if (/^<\//u.test(tag)) depth = Math.max(0, depth - 1);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_HTML_NODES) {
      throw new WebFetchError("RESPONSE_TOO_LARGE", "HTML node count exceeds the extraction limit.");
    }
    if (!/\/\s*>$/u.test(tag) && !/^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(?:\s|>)/iu.test(tag)) {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      if (maxDepth > MAX_HTML_DEPTH) {
        throw new WebFetchError("RESPONSE_TOO_LARGE", "HTML nesting exceeds the extraction limit.");
      }
    }
  }
}

export function webContentIsSufficient(content: ExtractedWebContent, html: string) {
  if (content.textLength >= 400 && content.paragraphCount >= 2 && content.linkDensity < 0.6) return true;
  if (content.textLength >= 250 && content.headingCount >= 1 && content.linkDensity < 0.45) return true;
  const shellSignals = /<noscript[^>]*>[^<]*(enable|启用).{0,30}javascript/i.test(html)
    || /<(?:div|main)[^>]+id=["'](?:app|root|__next|__nuxt)["'][^>]*>\s*<\/\w+>/i.test(html);
  return content.textLength >= 180 && !shellSignals && content.linkDensity < 0.35;
}

function normalizeMarkdown(value: string, baseUrl: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  const normalized = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : normalizeMarkdownLinks(line, baseUrl);
  });
  return normalized.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeMarkdownLinks(value: string, baseUrl: string) {
  return value.replace(/(!?\[[^\]]*\])\((<[^>]+>|[^)\s]+)([^)]*)\)/g, (
    match,
    label: string,
    rawHref: string,
    suffix: string
  ) => {
    const image = label.startsWith("!");
    if (image && /^!\[\s*\]$/u.test(label)) return "";
    const href = rawHref.startsWith("<") && rawHref.endsWith(">")
      ? rawHref.slice(1, -1)
      : rawHref;
    if (/^data:/i.test(href) || /^javascript:/i.test(href)) return image ? label.slice(1) : label;
    try {
      const resolved = stripTrackingParameters(new URL(href, baseUrl));
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return label;
      return `${label}(${resolved.href}${suffix})`;
    } catch {
      return label || match;
    }
  });
}

function stripTrackingParameters(url: URL) {
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_[a-z0-9_]+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url;
}
