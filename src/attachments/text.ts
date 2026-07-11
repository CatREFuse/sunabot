import fs from "node:fs";
import fsp from "node:fs/promises";
import chardet from "chardet";
import iconv from "iconv-lite";
import {
  SqliteChunkWriter,
  StreamingTextChunker,
  type AttachmentTextChunk,
  type TextChunkerOptions
} from "./chunks.js";

export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;
export const MAX_TEXT_INDEX_CHARACTERS = 20_000_000;
export const MAX_ENCODING_SAMPLE_BYTES = 256 * 1024;
export const DEFAULT_TEXT_PREVIEW_CHARACTERS = 2_000;

export type TextEncodingSource = "bom" | "utf8" | "chardet" | "fallback";
export type TextExtractionErrorCode = "too_large" | "invalid_text" | "unsupported_text_encoding";

export class TextExtractionError extends Error {
  readonly code: TextExtractionErrorCode;

  constructor(code: TextExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TextExtractionError";
    this.code = code;
  }
}

export interface TextEncodingDetection {
  encoding: string;
  source: TextEncodingSource;
  confidence: number;
  uncertain: boolean;
  utf8Valid: boolean;
  bomBytes: number;
  sampleBytes: number;
  bytesScanned: number;
  replacementRatio: number;
  controlRatio: number;
  nulByteRatio: number;
}

export interface DetectTextEncodingOptions {
  maxBytes?: number;
  sampleBytes?: number;
}

export interface ExtractTextFileOptions {
  maxBytes?: number;
  maxCharacters?: number;
  previewCharacters?: number;
  encoding?: string;
  encodingDetection?: TextEncodingDetection;
  chunking?: TextChunkerOptions;
  outputPath?: string;
  onChunk?: (chunk: AttachmentTextChunk) => void | Promise<void>;
}

export interface TextExtractionResult {
  encoding: string;
  encodingDetection: TextEncodingDetection;
  sizeBytes: number;
  characterCount: number;
  replacementRatio: number;
  controlRatio: number;
  chunksWritten: number;
  textPreview: string;
  truncated: boolean;
}

export function isAllowedAttachmentSize(sizeBytes: number) {
  return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= MAX_ATTACHMENT_BYTES;
}

export async function detectTextEncoding(
  filePath: string,
  options: DetectTextEncodingOptions = {}
): Promise<TextEncodingDetection> {
  const maxBytes = boundedPositiveInteger(options.maxBytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES, "maxBytes");
  const sampleLimit = boundedPositiveInteger(
    options.sampleBytes,
    MAX_ENCODING_SAMPLE_BYTES,
    MAX_ENCODING_SAMPLE_BYTES,
    "sampleBytes"
  );
  await assertRegularFileWithinLimit(filePath, maxBytes);
  const scan = await scanForEncoding(filePath, maxBytes, sampleLimit);
  const bom = detectBom(scan.sample);

  if (bom) {
    const quality = decodeQuality(scan.sample, bom.encoding);
    return detectionResult(scan, {
      encoding: bom.encoding,
      source: "bom",
      confidence: 100,
      bomBytes: bom.bytes,
      quality
    });
  }

  if (scan.utf8Valid) {
    const quality = decodeQuality(scan.sample, "utf8");
    return detectionResult(scan, {
      encoding: "utf8",
      source: "utf8",
      confidence: 100,
      bomBytes: 0,
      quality
    });
  }

  const candidates = encodingCandidates(scan.sample);
  const selected = candidates[0];
  if (!selected || selected.quality.score < 0.2) {
    throw new TextExtractionError("invalid_text", "No readable text encoding candidate was found");
  }

  return detectionResult(scan, {
    encoding: selected.encoding,
    source: selected.confidence > 0 ? "chardet" : "fallback",
    confidence: selected.confidence,
    bomBytes: 0,
    quality: selected.quality
  });
}

export async function extractTextFile(
  filePath: string,
  options: ExtractTextFileOptions = {}
): Promise<TextExtractionResult> {
  const maxBytes = boundedPositiveInteger(options.maxBytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES, "maxBytes");
  const maxCharacters = boundedPositiveInteger(
    options.maxCharacters,
    MAX_TEXT_INDEX_CHARACTERS,
    MAX_TEXT_INDEX_CHARACTERS,
    "maxCharacters"
  );
  const previewCharacters = boundedNonNegativeInteger(
    options.previewCharacters,
    DEFAULT_TEXT_PREVIEW_CHARACTERS,
    MAX_TEXT_INDEX_CHARACTERS,
    "previewCharacters"
  );
  const sizeBytes = await assertRegularFileWithinLimit(filePath, maxBytes);

  const encodingDetection = options.encodingDetection ?? (
    options.encoding
      ? suppliedEncodingDetection(options.encoding, sizeBytes)
      : await detectTextEncoding(filePath, { maxBytes })
  );
  const encoding = normalizeEncodingName(options.encoding ?? encodingDetection.encoding);
  if (!iconv.encodingExists(encoding)) {
    throw new TextExtractionError(
      "unsupported_text_encoding",
      `Unsupported text encoding: ${encoding}`
    );
  }

  const chunker = new StreamingTextChunker(options.chunking);
  const writer = options.outputPath ? await SqliteChunkWriter.open(options.outputPath) : undefined;
  const decoder = iconv.getDecoder(encoding, { stripBOM: true });
  let bytesRead = 0;
  let characterCount = 0;
  let replacementCharacters = 0;
  let controlCharacters = 0;
  let chunksWritten = 0;
  let textPreview = "";
  let truncated = false;
  let acceptingText = true;

  const emit = async (chunks: AttachmentTextChunk[]) => {
    for (const chunk of chunks) {
      if (writer) await writer.write(chunk);
      await options.onChunk?.(chunk);
      chunksWritten += 1;
    }
  };

  const acceptDecoded = async (decoded: string) => {
    if (!decoded) return;
    if (!acceptingText) {
      truncated = true;
      return;
    }

    const remaining = maxCharacters - characterCount;
    if (remaining <= 0) {
      truncated = true;
      acceptingText = false;
      return;
    }

    let accepted = decoded.slice(0, remaining);
    if (accepted.length < decoded.length && endsWithHighSurrogate(accepted)) {
      accepted = accepted.slice(0, -1);
    }
    if (accepted.length < decoded.length) {
      truncated = true;
      acceptingText = false;
    }
    if (!accepted) return;

    characterCount += accepted.length;
    const quality = measureDecodedText(accepted);
    replacementCharacters += quality.replacementCharacters;
    controlCharacters += quality.controlCharacters;
    if (textPreview.length < previewCharacters) {
      textPreview += accepted.slice(0, previewCharacters - textPreview.length);
    }
    await emit(chunker.push(accepted));
  };

  try {
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        throw new TextExtractionError("too_large", "File exceeds 256 MiB while being read");
      }
      await acceptDecoded(decoder.write(chunk));
    }
    await acceptDecoded(decoder.end() ?? "");
    await emit(chunker.end());
    if (writer) await writer.commit();
  } catch (error) {
    await writer?.abort();
    throw error;
  }

  return {
    encoding,
    encodingDetection,
    sizeBytes: bytesRead,
    characterCount,
    replacementRatio: characterCount ? replacementCharacters / characterCount : 0,
    controlRatio: characterCount ? controlCharacters / characterCount : 0,
    chunksWritten,
    textPreview,
    truncated
  };
}

interface EncodingScan {
  sample: Buffer;
  bytesScanned: number;
  utf8Valid: boolean;
  nulByteRatio: number;
}

async function scanForEncoding(filePath: string, maxBytes: number, sampleLimit: number): Promise<EncodingScan> {
  const sampleChunks: Buffer[] = [];
  let sampledBytes = 0;
  let bytesScanned = 0;
  let utf8Valid = true;
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytesScanned += chunk.length;
    if (bytesScanned > maxBytes) {
      throw new TextExtractionError("too_large", "File exceeds 256 MiB while being read");
    }

    if (sampledBytes < sampleLimit) {
      const length = Math.min(chunk.length, sampleLimit - sampledBytes);
      sampleChunks.push(Buffer.from(chunk.subarray(0, length)));
      sampledBytes += length;
    }

    if (utf8Valid) {
      try {
        utf8Decoder.decode(chunk, { stream: true });
      } catch {
        utf8Valid = false;
      }
    }
  }
  if (utf8Valid) {
    try {
      utf8Decoder.decode();
    } catch {
      utf8Valid = false;
    }
  }

  const sample = Buffer.concat(sampleChunks, sampledBytes);
  let nulBytes = 0;
  for (const byte of sample) {
    if (byte === 0) nulBytes += 1;
  }
  return {
    sample,
    bytesScanned,
    utf8Valid,
    nulByteRatio: sample.length ? nulBytes / sample.length : 0
  };
}

function detectBom(sample: Buffer) {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return { encoding: "utf8", bytes: 3 };
  }
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return { encoding: "utf16le", bytes: 2 };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return { encoding: "utf16be", bytes: 2 };
  }
  return undefined;
}

interface EncodingCandidate {
  encoding: string;
  confidence: number;
  quality: DecodedTextQuality;
  score: number;
}

function encodingCandidates(sample: Buffer): EncodingCandidate[] {
  const evidenceByEncoding = new Map<string, { confidence: number; language?: string }>();
  for (const match of chardet.analyse(sample)) {
    const encoding = normalizeEncodingName(match.name);
    if (!iconv.encodingExists(encoding)) continue;
    const current = evidenceByEncoding.get(encoding);
    if (!current || match.confidence > current.confidence) {
      evidenceByEncoding.set(encoding, {
        confidence: match.confidence,
        language: match.lang
      });
    }
  }

  const encodings = new Set([...evidenceByEncoding.keys(), "gb18030", "gbk"]);
  return [...encodings]
    .filter((encoding) => iconv.encodingExists(encoding))
    .map((encoding) => {
      const evidence = evidenceByEncoding.get(encoding);
      const confidence = evidence?.confidence ?? 0;
      const quality = decodeQuality(sample, encoding);
      const languageAffinity = evidence?.language === "zh" ? Math.min(0.25, quality.cjkRatio * 0.5) : 0;
      return {
        encoding,
        confidence,
        quality,
        score: quality.score + confidence / 200 + languageAffinity
      };
    })
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence);
}

interface DecodedTextQuality {
  replacementRatio: number;
  controlRatio: number;
  cjkRatio: number;
  score: number;
}

function decodeQuality(sample: Buffer, encoding: string): DecodedTextQuality {
  const decoded = iconv.decode(sample, encoding, { stripBOM: true });
  const measured = measureDecodedText(decoded);
  const total = Math.max(1, decoded.length);
  const replacementRatio = measured.replacementCharacters / total;
  const controlRatio = measured.controlCharacters / total;
  const characters = [...decoded];
  const cjkCharacters = characters.filter((character) => isCjkCodePoint(character.codePointAt(0) ?? 0)).length;
  return {
    replacementRatio,
    controlRatio,
    cjkRatio: cjkCharacters / Math.max(1, characters.length),
    score: Math.max(0, 1 - replacementRatio * 20 - controlRatio * 10)
  };
}

function measureDecodedText(text: string) {
  let replacementCharacters = 0;
  let controlCharacters = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0xfffd) replacementCharacters += 1;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controlCharacters += 1;
    }
  }
  return { replacementCharacters, controlCharacters };
}

function detectionResult(
  scan: EncodingScan,
  selected: {
    encoding: string;
    source: TextEncodingSource;
    confidence: number;
    bomBytes: number;
    quality: DecodedTextQuality;
  }
): TextEncodingDetection {
  return {
    encoding: normalizeEncodingName(selected.encoding),
    source: selected.source,
    confidence: selected.confidence,
    uncertain:
      selected.source === "fallback" ||
      selected.confidence < 20 ||
      selected.quality.replacementRatio > 0.01 ||
      selected.quality.controlRatio > 0.01,
    utf8Valid: scan.utf8Valid,
    bomBytes: selected.bomBytes,
    sampleBytes: scan.sample.length,
    bytesScanned: scan.bytesScanned,
    replacementRatio: selected.quality.replacementRatio,
    controlRatio: selected.quality.controlRatio,
    nulByteRatio: scan.nulByteRatio
  };
}

function suppliedEncodingDetection(encoding: string, sizeBytes: number): TextEncodingDetection {
  return {
    encoding: normalizeEncodingName(encoding),
    source: "fallback",
    confidence: 0,
    uncertain: true,
    utf8Valid: false,
    bomBytes: 0,
    sampleBytes: 0,
    bytesScanned: sizeBytes,
    replacementRatio: 0,
    controlRatio: 0,
    nulByteRatio: 0
  };
}

export function normalizeEncodingName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[_-]/gu, "");
  if (normalized === "utf8" || normalized === "ascii") return "utf8";
  if (normalized === "utf16le" || normalized === "ucs2") return "utf16le";
  if (normalized === "utf16be") return "utf16be";
  if (normalized === "gb2312" || normalized === "cp936") return "gbk";
  if (normalized === "gb18030") return "gb18030";
  return value.trim().toLowerCase().replace(/_/gu, "-");
}

async function assertRegularFileWithinLimit(filePath: string, maxBytes: number) {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) {
    throw new TextExtractionError("invalid_text", "Text input is not a regular file");
  }
  if (stats.size > maxBytes) {
    throw new TextExtractionError("too_large", "File exceeds 256 MiB");
  }
  return stats.size;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  name: string
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${hardMaximum}`);
  }
  return resolved;
}

function boundedNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  name: string
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > hardMaximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${hardMaximum}`);
  }
  return resolved;
}

function endsWithHighSurrogate(value: string) {
  if (!value) return false;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function isCjkCodePoint(codePoint: number) {
  return (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x323af);
}
