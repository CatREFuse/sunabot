export const WEBFETCH_FULL_TOKEN_BUDGET = 6_000;
export const WEBFETCH_MATCH_TOKEN_BUDGET = 3_500;
export const WEBFETCH_CACHE_TOKEN_BUDGET = 32_000;
const BLOCK_TOKEN_TARGET = 800;

export interface WebContentBlock {
  index: number;
  headingPath: string[];
  markdown: string;
  estimatedTokens: number;
}

export interface BudgetedContent {
  content: string;
  truncated: boolean;
  omittedBlockCount: number;
}

export function estimateWebTokens(value: string) {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  for (const character of value) {
    if (/^[\x20-\x7e]$/.test(character)) asciiRun += 1;
    else {
      flushAscii();
      if (!/\s/u.test(character)) tokens += 1;
    }
  }
  flushAscii();
  return tokens;
}

export function splitWebContent(markdown: string): WebContentBlock[] {
  const sections = headingSections(markdown);
  const blocks: WebContentBlock[] = [];
  for (const section of sections) {
    const headingPrefix = section.headingPath.length
      ? `${section.headingPath.map((heading, index) => `${"#".repeat(Math.min(index + 2, 6))} ${heading}`).join("\n")}\n\n`
      : "";
    const pieces = splitOversizedSection(
      section.body,
      Math.max(1, BLOCK_TOKEN_TARGET - estimateWebTokens(headingPrefix))
    );
    for (const piece of pieces) {
      const value = `${headingPrefix}${piece}`.trim();
      if (!value) continue;
      blocks.push({
        index: blocks.length,
        headingPath: [...section.headingPath],
        markdown: value,
        estimatedTokens: estimateWebTokens(value)
      });
    }
  }
  return blocks;
}

export function budgetBlocks(blocks: readonly WebContentBlock[], budget: number): BudgetedContent {
  const selected: WebContentBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.estimatedTokens > budget) break;
    selected.push(block);
    used += block.estimatedTokens;
  }
  if (!selected.length && blocks[0]) {
    const content = truncateMarkdownAtBoundary(blocks[0].markdown, budget);
    return { content, truncated: true, omittedBlockCount: Math.max(0, blocks.length - 1) };
  }
  return {
    content: selected.map((block) => block.markdown).join("\n\n").trim(),
    truncated: selected.length < blocks.length,
    omittedBlockCount: Math.max(0, blocks.length - selected.length)
  };
}

function headingSections(markdown: string) {
  const sections: Array<{ headingPath: string[]; body: string }> = [];
  const headings: string[] = [];
  let body: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ headingPath: [...headings], body: text });
    body = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (!match) {
      body.push(line);
      continue;
    }
    flush();
    const level = match[1]!.length;
    headings.splice(level - 1);
    headings[level - 1] = match[2]!;
  }
  flush();
  if (!sections.length && markdown.trim()) sections.push({ headingPath: [], body: markdown.trim() });
  return sections;
}

function splitOversizedSection(value: string, target: number) {
  if (estimateWebTokens(value) <= target) return [value];
  const units = paragraphUnits(value);
  const pieces: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const unit of units) {
    const unitTokens = estimateWebTokens(unit);
    if (unitTokens > target) {
      if (current.length) {
        pieces.push(current.join("\n\n").trim());
        current = [];
        tokens = 0;
      }
      pieces.push(...splitLargeTextUnit(unit, target));
      continue;
    }
    if (current.length && tokens + unitTokens > target) {
      pieces.push(current.join("\n\n").trim());
      current = [];
      tokens = 0;
    }
    current.push(unit);
    tokens += unitTokens;
  }
  if (current.length) pieces.push(current.join("\n\n").trim());
  return pieces.filter(Boolean);
}

function splitLargeTextUnit(value: string, target: number) {
  if (/^\s*```[\s\S]*```\s*$/m.test(value)) return splitFencedCodeBlock(value, target);

  const atoms = markdownAtoms(value);
  const pieces: string[] = [];
  let current = "";
  let used = 0;
  for (const atom of atoms) {
    const atomTokens = estimateWebTokens(atom);
    if (current && used + atomTokens > target) {
      pieces.push(current.trim());
      current = "";
      used = 0;
    }
    if (!current && atomTokens > target && !isStructuredMarkdownAtom(atom)) {
      for (const chunk of splitRawText(atom, target)) pieces.push(chunk);
      continue;
    }
    current += atom;
    used += atomTokens;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function splitFencedCodeBlock(value: string, target: number) {
  const lines = value.trim().split("\n");
  const opening = lines.shift() ?? "```";
  const closing = lines.at(-1)?.trim().startsWith("```") ? lines.pop()! : "```";
  const closingCost = estimateWebTokens(`${closing}\n`);
  const pieces: string[] = [];
  let current = [opening];
  let used = estimateWebTokens(`${opening}\n`) + closingCost;
  for (const line of lines) {
    const lineCost = estimateWebTokens(`${line}\n`);
    if (current.length > 1 && used + lineCost > target) {
      current.push(closing);
      pieces.push(current.join("\n"));
      current = [opening];
      used = estimateWebTokens(`${opening}\n`) + closingCost;
    }
    if (lineCost > target - used) {
      const chunks = splitRawText(line, Math.max(1, target - used));
      for (const chunk of chunks) {
        if (current.length > 1 && used + estimateWebTokens(`${chunk}\n`) + closingCost > target) {
          current.push(closing);
          pieces.push(current.join("\n"));
          current = [opening];
          used = estimateWebTokens(`${opening}\n`) + closingCost;
        }
        current.push(chunk);
        used += estimateWebTokens(`${chunk}\n`);
      }
      continue;
    }
    current.push(line);
    used += lineCost;
  }
  if (current.length > 1) current.push(closing);
  if (current.length > 1) pieces.push(current.join("\n"));
  return pieces;
}

function markdownAtoms(value: string) {
  return value.match(/!?\[[^\]]*\]\([^)]*\)|`[^`]*`|\s+|\S+/g) ?? [value];
}

function isStructuredMarkdownAtom(value: string) {
  return /^!?\[[^\]]*\]\([^)]*\)$/.test(value) || /^`[^`]*`$/.test(value);
}

function splitRawText(value: string, target: number) {
  const chunks: string[] = [];
  let current = "";
  let used = 0;
  for (const character of [...value]) {
    const cost = estimateWebTokens(character);
    if (current && used + cost > target) {
      chunks.push(current);
      current = "";
      used = 0;
    }
    current += character;
    used += cost;
  }
  if (current) chunks.push(current);
  return chunks;
}

function paragraphUnits(value: string) {
  const units: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of value.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && !line.trim()) {
      if (current.length) units.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) units.push(current.join("\n"));
  return units;
}

function truncateMarkdownAtBoundary(value: string, budget: number) {
  const lines: string[] = [];
  let used = 0;
  let inFence = false;
  const closingFence = "```";
  const closingFenceCost = estimateWebTokens(`${closingFence}\n`);
  for (const line of value.split("\n")) {
    const cost = estimateWebTokens(`${line}\n`);
    const opensOrClosesFence = /^\s*```/.test(line);
    const nextInFence: boolean = opensOrClosesFence ? !inFence : inFence;
    const reserve = nextInFence ? closingFenceCost : 0;
    if (used + cost + reserve > budget) break;
    lines.push(line);
    used += cost;
    inFence = nextInFence;
  }
  if (inFence && used + closingFenceCost <= budget) lines.push(closingFence);
  return lines.join("\n").trim();
}
