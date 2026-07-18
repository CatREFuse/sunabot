import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SqliteChunkWriter,
  chunkText,
  type AttachmentTextChunk
} from "./chunks.js";
import { extractOfficeText } from "./office.js";
import {
  extractPdfTextByPage,
  getPdfPageCount,
  renderPdfPages,
  renderPdfPagesBestEffort
} from "./pdf.js";
import { MAX_TEXT_INDEX_CHARACTERS } from "./text.js";

type ParserWorkerPayload =
  | { kind: "pdf_extract"; inputPath: string; outputPath: string }
  | { kind: "office_extract"; inputPath: string; outputPath: string }
  | { kind: "pdf_info"; inputPath: string }
  | { kind: "pdf_render"; inputPath: string; pageNumbers: number[] }
  | { kind: "pdf_render_best_effort"; inputPath: string; pageNumbers: number[] };

interface WorkerContext {
  taskId: string;
  workDir: string;
}

export interface IndexedDocumentResult {
  pageCount?: number;
  sectionCount?: number;
  textCharacterCount: number;
  indexedCharacterCount: number;
  textPreview: string;
  truncated: boolean;
}

export interface RenderedPdfPageFile {
  pageNumber: number;
  width: number;
  height: number;
  contentType: "image/png";
  outputPath: string;
}

export interface BestEffortPdfRenderResult {
  pages: RenderedPdfPageFile[];
  failures: Array<{ pageNumber: number; error: string }>;
}

export default async function runParserWorkerTask(
  value: unknown,
  context: WorkerContext
) {
  const payload = parsePayload(value);
  if (payload.kind === "pdf_extract") {
    assertOutputPath(payload.outputPath, context.workDir);
    const extraction = await extractPdfTextByPage(payload.inputPath, {
      maxCharacters: MAX_TEXT_INDEX_CHARACTERS + 1
    });
    return writeIndexedDocument(payload.outputPath, extraction.pages.map((page) => ({
      text: page.text,
      pageNumber: page.pageNumber,
      title: `第 ${page.pageNumber} 页`
    })), {
      pageCount: extraction.pageCount,
      textCharacterCount: extraction.textCharacterCount,
      alreadyTruncated: extraction.truncated === true
    });
  }
  if (payload.kind === "office_extract") {
    assertOutputPath(payload.outputPath, context.workDir);
    const extraction = await extractOfficeText(payload.inputPath);
    return writeIndexedDocument(payload.outputPath, extraction.sections.map((section) => ({
      text: section.text,
      slideNumber: section.kind === "slide" ? section.index + 1 : undefined,
      sheetName: section.kind === "sheet" ? section.title.replace(/^工作表\s*/, "") : undefined,
      title: section.title
    })), {
      pageCount: extraction.pageCount,
      sectionCount: extraction.sections.length,
      textCharacterCount: extraction.textCharacterCount,
      alreadyTruncated: false
    });
  }
  if (payload.kind === "pdf_info") {
    return { pageCount: await getPdfPageCount(payload.inputPath) };
  }

  if (payload.kind === "pdf_render_best_effort") {
    const rendered = await renderPdfPagesBestEffort(payload.inputPath, payload.pageNumbers);
    const pages: RenderedPdfPageFile[] = [];
    const failures = rendered.failures.slice();
    for (const page of rendered.pages) {
      const outputPath = path.join(context.workDir, `render-${page.pageNumber}.png`);
      try {
        await writeFile(outputPath, page.bytes, { flag: "w", mode: 0o600 });
        pages.push({
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
          contentType: page.contentType,
          outputPath
        });
      } catch (error) {
        await rm(outputPath, { force: true }).catch(() => undefined);
        failures.push({ pageNumber: page.pageNumber, error: boundedErrorMessage(error) });
      }
    }
    return { pages, failures } satisfies BestEffortPdfRenderResult;
  }

  const pages = await renderPdfPages(payload.inputPath, payload.pageNumbers);
  const outputs: RenderedPdfPageFile[] = [];
  for (const page of pages) {
    const outputPath = path.join(context.workDir, `render-${page.pageNumber}.png`);
    await writeFile(outputPath, page.bytes, { flag: "w", mode: 0o600 });
    outputs.push({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      contentType: page.contentType,
      outputPath
    });
  }
  return outputs;
}

function parsePayload(value: unknown): ParserWorkerPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Parser worker payload must be an object.");
  }
  const payload = value as Partial<ParserWorkerPayload> & Record<string, unknown>;
  if (
    payload.kind !== "pdf_extract" &&
    payload.kind !== "office_extract" &&
    payload.kind !== "pdf_info" &&
    payload.kind !== "pdf_render" &&
    payload.kind !== "pdf_render_best_effort"
  ) {
    throw new TypeError("Unsupported parser worker task.");
  }
  if (typeof payload.inputPath !== "string" || !path.isAbsolute(payload.inputPath)) {
    throw new TypeError("Parser worker inputPath must be absolute.");
  }
  if (
    (payload.kind === "pdf_extract" || payload.kind === "office_extract") &&
    (typeof payload.outputPath !== "string" || !path.isAbsolute(payload.outputPath))
  ) {
    throw new TypeError("Parser worker outputPath is invalid.");
  }
  if (payload.kind === "pdf_render" || payload.kind === "pdf_render_best_effort") {
    if (!Array.isArray(payload.pageNumbers) || !payload.pageNumbers.every((page) => Number.isSafeInteger(page) && page > 0)) {
      throw new TypeError("Parser worker pageNumbers are invalid.");
    }
    return payload as ParserWorkerPayload;
  }
  return payload as ParserWorkerPayload;
}

function boundedErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

interface IndexedSourceSection {
  text: string;
  title: string;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

async function writeIndexedDocument(
  outputPath: string,
  sections: readonly IndexedSourceSection[],
  metadata: {
    pageCount?: number;
    sectionCount?: number;
    textCharacterCount: number;
    alreadyTruncated: boolean;
  }
): Promise<IndexedDocumentResult> {
  const writer = await SqliteChunkWriter.open(outputPath);
  let indexedCharacterCount = 0;
  let chunkIndex = 0;
  let textPreview = "";
  let truncated = metadata.alreadyTruncated;
  try {
    for (const section of sections) {
      const remaining = MAX_TEXT_INDEX_CHARACTERS - indexedCharacterCount;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const text = section.text.slice(0, remaining);
      if (text.length < section.text.length) truncated = true;
      if (textPreview.length < 2_000) {
        textPreview += `${textPreview ? "\n" : ""}${text}`.slice(0, 2_000 - textPreview.length);
      }
      for (const chunk of chunkText(text, { title: () => section.title })) {
        await writer.write(withSectionLocation(chunk, chunkIndex, section));
        chunkIndex += 1;
      }
      indexedCharacterCount += text.length;
      if (truncated) break;
    }
    await writer.commit();
  } catch (error) {
    await writer.abort();
    throw error;
  }
  return {
    pageCount: metadata.pageCount,
    sectionCount: metadata.sectionCount,
    textCharacterCount: metadata.textCharacterCount,
    indexedCharacterCount,
    textPreview,
    truncated: truncated || indexedCharacterCount < metadata.textCharacterCount
  };
}

function withSectionLocation(
  chunk: AttachmentTextChunk,
  index: number,
  section: IndexedSourceSection
): AttachmentTextChunk {
  return {
    ...chunk,
    index,
    pageNumber: section.pageNumber,
    slideNumber: section.slideNumber,
    sheetName: section.sheetName
  };
}

function assertOutputPath(outputPath: string, workDir: string) {
  const resolvedOutput = path.resolve(outputPath);
  const resolvedWorkDir = path.resolve(workDir);
  const relative = path.relative(resolvedWorkDir, resolvedOutput);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Parser worker outputPath escapes its work directory.");
  }
}
