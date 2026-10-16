/** Extract model-provided JSON without requiring a bare JSON response. */
export function parseModelJson(text: string): unknown {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/giu)) {
    candidates.push(match[1]!.trim());
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Model prose may surround a structured result.
    }
  }
  const stack: string[] = [];
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let end = 0; end < text.length; end += 1) {
    const char = text[end]!;
    if (start < 0) {
      if (char !== "{" && char !== "[") continue;
      start = end;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const opening = stack.pop();
      if ((char === "}" && opening !== "{") || (char === "]" && opening !== "[")) {
        stack.length = 0;
        start = -1;
        continue;
      }
      if (stack.length) continue;
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        start = -1;
      }
    }
  }
  return undefined;
}

export function modelContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value) ?? "";
}
