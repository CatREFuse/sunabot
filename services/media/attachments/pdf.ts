import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfPageText {
  pageNumber: number;
  text: string;
}

export interface PdfTextExtraction {
  pageCount: number;
  pages: PdfPageText[];
  textCharacterCount: number;
  truncated?: boolean;
}

export interface PdfTextExtractionOptions {
  maxCharacters?: number;
}

export interface PdfRenderOptions {
  maxLongEdge?: number;
  scale?: number;
}

export interface RenderedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  contentType: "image/png";
  bytes: Buffer;
}

export interface PdfPageRenderFailure {
  pageNumber: number;
  error: string;
}

export interface PdfPageRenderBatchResult {
  pages: RenderedPdfPage[];
  failures: PdfPageRenderFailure[];
}

type PdfInput = string | Uint8Array;
type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

const DEFAULT_RENDER_SCALE = 2;
const DEFAULT_RENDER_MAX_LONG_EDGE = 2_048;

export async function extractPdfTextByPage(
  input: PdfInput,
  options: PdfTextExtractionOptions = {}
): Promise<PdfTextExtraction> {
  const maxCharacters = options.maxCharacters == null
    ? Number.MAX_SAFE_INTEGER
    : positiveNumber(options.maxCharacters, Number.MAX_SAFE_INTEGER, "maxCharacters");
  return withPdfDocument(input, async (document) => {
    const pages: PdfPageText[] = [];
    let textCharacterCount = 0;
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (textCharacterCount >= maxCharacters) {
        truncated = true;
        break;
      }
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const extractedText = textContentToString(content.items);
        const remaining = maxCharacters - textCharacterCount;
        const text = extractedText.slice(0, remaining);
        pages.push({ pageNumber, text });
        textCharacterCount += text.length;
        if (text.length < extractedText.length) {
          truncated = true;
          break;
        }
      } finally {
        page.cleanup();
      }
    }
    return {
      pageCount: document.numPages,
      pages,
      textCharacterCount,
      ...(truncated ? { truncated: true as const } : {})
    };
  });
}

export async function renderPdfPages(
  input: PdfInput,
  pageNumbers: readonly number[],
  options: PdfRenderOptions = {}
): Promise<RenderedPdfPage[]> {
  const requestedPages = uniquePositiveIntegers(pageNumbers);
  if (!requestedPages.length) return [];

  const renderOptions = resolveRenderOptions(options);
  return withPdfDocument(input, async (document) => {
    for (const pageNumber of requestedPages) {
      if (pageNumber > document.numPages) {
        throw new RangeError(`PDF page ${pageNumber} is outside 1-${document.numPages}`);
      }
    }

    const rendered: RenderedPdfPage[] = [];
    for (const pageNumber of requestedPages) {
      rendered.push(await renderPdfPage(document, pageNumber, renderOptions));
    }
    return rendered;
  });
}

export async function renderPdfPagesBestEffort(
  input: PdfInput,
  pageNumbers: readonly number[],
  options: PdfRenderOptions = {}
): Promise<PdfPageRenderBatchResult> {
  const requestedPages = uniquePositiveIntegers(pageNumbers);
  if (!requestedPages.length) return { pages: [], failures: [] };

  const renderOptions = resolveRenderOptions(options);
  return withPdfDocument(input, async (document) => {
    const pages: RenderedPdfPage[] = [];
    const failures: PdfPageRenderFailure[] = [];
    for (const pageNumber of requestedPages) {
      try {
        if (pageNumber > document.numPages) {
          throw new RangeError(`PDF page ${pageNumber} is outside 1-${document.numPages}`);
        }
        pages.push(await renderPdfPage(document, pageNumber, renderOptions));
      } catch (error) {
        failures.push({ pageNumber, error: boundedErrorMessage(error) });
      }
    }
    return { pages, failures };
  });
}

export async function getPdfPageCount(input: PdfInput) {
  return withPdfDocument(input, async (document) => document.numPages);
}

async function withPdfDocument<T>(
  input: PdfInput,
  operation: (document: PdfDocument) => Promise<T>
): Promise<T> {
  const loadingTask = getDocument({
    ...(typeof input === "string" ? { url: input } : { data: Uint8Array.from(input) }),
    standardFontDataUrl: standardFontDataUrl(),
    useSystemFonts: true
  });
  try {
    const document = await loadingTask.promise;
    return await operation(document);
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

interface ResolvedPdfRenderOptions {
  maxLongEdge: number;
  requestedScale: number;
}

function resolveRenderOptions(options: PdfRenderOptions): ResolvedPdfRenderOptions {
  return {
    maxLongEdge: positiveNumber(options.maxLongEdge, DEFAULT_RENDER_MAX_LONG_EDGE, "maxLongEdge"),
    requestedScale: positiveNumber(options.scale, DEFAULT_RENDER_SCALE, "scale")
  };
}

async function renderPdfPage(
  document: PdfDocument,
  pageNumber: number,
  options: ResolvedPdfRenderOptions
): Promise<RenderedPdfPage> {
  const page = await document.getPage(pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const boundedScale = Math.min(
      options.requestedScale,
      options.maxLongEdge / Math.max(baseViewport.width, baseViewport.height)
    );
    const viewport = page.getViewport({ scale: Math.max(boundedScale, 0.01) });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      background: "rgb(255,255,255)"
    }).promise;
    return {
      pageNumber,
      width,
      height,
      contentType: "image/png",
      bytes: canvas.toBuffer("image/png")
    };
  } finally {
    page.cleanup();
  }
}

function boundedErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function textContentToString(items: readonly unknown[]) {
  let result = "";
  for (const value of items) {
    if (!value || typeof value !== "object" || !("str" in value)) continue;
    const item = value as { str?: unknown; hasEOL?: unknown };
    const text = String(item.str ?? "");
    if (text) {
      if (result && !result.endsWith("\n") && !result.endsWith(" ")) result += " ";
      result += text;
    }
    if (item.hasEOL === true && !result.endsWith("\n")) result += "\n";
  }
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

let cachedStandardFontDataUrl: string | undefined;

function standardFontDataUrl() {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;
  const require = createRequire(import.meta.url);
  const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
  cachedStandardFontDataUrl = pathToFileURL(path.join(packageDirectory, "standard_fonts", path.sep)).href;
  return cachedStandardFontDataUrl;
}

function uniquePositiveIntegers(values: readonly number[]) {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("pageNumbers must contain positive integers");
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function positiveNumber(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new RangeError(`${name} must be greater than zero`);
  return result;
}
