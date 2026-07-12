const INLINE_PATTERN = /(<\/?[A-Za-z][^>\n]*>)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(@\{\s*[A-Za-z_][\w.-]*\s*\}|\{\{\s*[A-Za-z_][\w.-]*\s*\}\})/g;

export function highlightedPromptMarkup(content: string) {
  const lines = content.split("\n");
  const highlighted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isCodeFence(line)) {
      highlighted.push(highlightLine(line));
      continue;
    }

    const block = [line];
    while (index + 1 < lines.length) {
      index += 1;
      const nextLine = lines[index] ?? "";
      block.push(nextLine);
      if (isCodeFence(nextLine)) break;
    }
    highlighted.push(highlightCodeBlock(block));
  }
  return highlighted.join("\n");
}

function highlightLine(line: string) {
  const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (heading) {
    return `${escapeHtml(heading[1] ?? "")}<span class="markup-heading"><span class="markup-marker">${escapeHtml(heading[2] ?? "")}</span>${escapeHtml(heading[3] ?? "")}${highlightInline(heading[4] ?? "")}</span>`;
  }

  const quote = line.match(/^(\s*)(>)(\s?)(.*)$/);
  if (quote) {
    return `${escapeHtml(quote[1] ?? "")}<span class="markup-quote"><span class="markup-marker">${escapeHtml(quote[2] ?? "")}</span>${escapeHtml(quote[3] ?? "")}${highlightInline(quote[4] ?? "")}</span>`;
  }

  const list = line.match(/^(\s*)([-+*]|\d+\.)(\s+)(.*)$/);
  if (list) {
    return `${escapeHtml(list[1] ?? "")}<span class="markup-list-marker">${escapeHtml(list[2] ?? "")}</span>${escapeHtml(list[3] ?? "")}${highlightInline(list[4] ?? "")}`;
  }

  return highlightInline(line);
}

function highlightCodeBlock(lines: readonly string[]) {
  const content = lines.map((line, index) => (
    index === 0 || (index === lines.length - 1 && isCodeFence(line))
      ? wrap("markup-code-fence", line)
      : escapeHtml(line)
  )).join("\n");
  return `<span class="markup-code-block">${content}</span>`;
}

function isCodeFence(line: string) {
  return /^\s*```/.test(line);
}

function highlightInline(value: string) {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    result += escapeHtml(value.slice(cursor, index));
    const token = match[0];
    if (match[1]) result += wrap("markup-xml", token);
    else if (match[2]) result += wrap("markup-code", token);
    else if (match[3]) result += wrap("markup-bold", token);
    else if (match[4]) result += wrap("markup-italic", token);
    else result += wrap("markup-variable", token);
    cursor = index + token.length;
  }
  return result + escapeHtml(value.slice(cursor));
}

function wrap(className: string, value: string) {
  return `<span class="${className}">${escapeHtml(value)}</span>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
