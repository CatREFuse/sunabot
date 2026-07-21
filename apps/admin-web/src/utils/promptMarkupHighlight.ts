const INLINE_PATTERN = /(<\/?[A-Za-z](?:"[^"\n]*"|'[^'\n]*'|[^>"'\n])*>)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(@\{\s*[A-Za-z_][\w.-]*\s*\}|\{\{\s*[A-Za-z_][\w.-]*\s*\}\})/g;

export function highlightedPromptMarkup(content: string, variableNames?: ReadonlySet<string>) {
  const lines = content.split("\n");
  const highlighted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isCodeFence(line)) {
      highlighted.push(highlightLine(line, variableNames));
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

function highlightLine(line: string, variableNames?: ReadonlySet<string>) {
  const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (heading) {
    return `${escapeHtml(heading[1] ?? "")}<span class="markup-heading"><span class="markup-marker">${escapeHtml(heading[2] ?? "")}</span>${escapeHtml(heading[3] ?? "")}${highlightInline(heading[4] ?? "", variableNames)}</span>`;
  }

  const quote = line.match(/^(\s*)(>)(\s?)(.*)$/);
  if (quote) {
    return `${escapeHtml(quote[1] ?? "")}<span class="markup-quote"><span class="markup-marker">${escapeHtml(quote[2] ?? "")}</span>${escapeHtml(quote[3] ?? "")}${highlightInline(quote[4] ?? "", variableNames)}</span>`;
  }

  const list = line.match(/^(\s*)([-+*]|\d+\.)(\s+)(.*)$/);
  if (list) {
    return `${escapeHtml(list[1] ?? "")}<span class="markup-list-marker">${escapeHtml(list[2] ?? "")}</span>${escapeHtml(list[3] ?? "")}${highlightInline(list[4] ?? "", variableNames)}`;
  }

  return highlightInline(line, variableNames);
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

function highlightInline(value: string, variableNames?: ReadonlySet<string>) {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    result += escapeHtml(value.slice(cursor, index));
    const token = match[0];
    if (match[1]) result += highlightXmlToken(token);
    else if (match[2]) result += wrap("markup-code", token);
    else if (match[3]) result += wrap("markup-bold", token);
    else if (match[4]) result += wrap("markup-italic", token);
    else {
      const name = promptVariableName(token);
      result += name && (!variableNames || variableNames.has(name))
        ? wrap("markup-variable markup-code", token)
        : escapeHtml(token);
    }
    cursor = index + token.length;
  }
  return result + escapeHtml(value.slice(cursor));
}

function highlightXmlToken(value: string) {
  const attribute = value.match(/\s+s-if\s*=\s*(["'])(.*?)\1/u);
  if (!attribute || attribute.index == null) return wrap("markup-xml", value);
  const start = attribute.index;
  const condition = attribute[2] ?? "";
  const conditionStart = attribute[0].indexOf(condition);
  const directive = [
    escapeHtml(attribute[0].slice(0, conditionStart)),
    `<span class="markup-condition">${escapeHtml(condition)}</span>`,
    escapeHtml(attribute[0].slice(conditionStart + condition.length))
  ].join("");
  return [
    '<span class="markup-xml">',
    escapeHtml(value.slice(0, start)),
    `<span class="markup-directive">${directive}</span>`,
    escapeHtml(value.slice(start + attribute[0].length)),
    "</span>"
  ].join("");
}

function promptVariableName(value: string) {
  return value.match(/^@\{\s*([A-Za-z_][\w.-]*)\s*\}$/)?.[1]
    ?? value.match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/)?.[1];
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
