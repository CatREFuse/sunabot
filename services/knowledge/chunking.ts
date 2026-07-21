import type { KnowledgeChunk, KnowledgeDocumentFormat } from "./types.js";

export function chunkKnowledgeDocument(
  content: string,
  format: KnowledgeDocumentFormat
): KnowledgeChunk[] {
  const lines = stripLeadingBom(content).split(/\r\n|\n|\r/u);
  return format === "jsonl" ? chunkJsonLines(lines) : chunkParagraphs(lines);
}

function chunkJsonLines(lines: string[]) {
  return lines.flatMap((line, index) => {
    const content = line.trim();
    return content ? [{
      ordinal: 0,
      startLine: index + 1,
      endLine: index + 1,
      content
    }] : [];
  }).map((chunk, ordinal) => ({ ...chunk, ordinal }));
}

function chunkParagraphs(lines: string[]) {
  const chunks: KnowledgeChunk[] = [];
  let startLine = 0;
  let paragraph: string[] = [];

  const flush = (endLine: number) => {
    const content = paragraph.join("\n").trim();
    if (content) {
      chunks.push({
        ordinal: chunks.length,
        startLine,
        endLine,
        content
      });
    }
    startLine = 0;
    paragraph = [];
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      if (paragraph.length) flush(lineNumber - 1);
      return;
    }
    if (!paragraph.length) startLine = lineNumber;
    paragraph.push(line);
  });
  if (paragraph.length) flush(lines.length);
  return chunks;
}

function stripLeadingBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
