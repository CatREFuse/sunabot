import fsp from "node:fs/promises";
import path from "node:path";
import { fileTypeFromFile, type FileTypeResult } from "file-type";
import {
  MAX_ATTACHMENT_BYTES,
  detectTextEncoding,
  type TextEncodingDetection,
  TextExtractionError
} from "./text.js";
import { preflightZipFile, type ZipOfficeKind } from "./zipPreflight.js";

export type AttachmentKind =
  | "text"
  | "pdf"
  | "presentation"
  | "document"
  | "spreadsheet"
  | "image"
  | "unsupported";

export type AttachmentDetectionSource = "magic" | "container" | "text" | "none";

export interface DetectedAttachmentType {
  kind: AttachmentKind;
  format?: string;
  mimeType?: string;
  source: AttachmentDetectionSource;
  declaredExtension?: string;
  detectedExtension?: string;
  extensionMismatch: boolean;
  textEncoding?: TextEncodingDetection;
  reason?: string;
}

export interface DetectAttachmentOptions {
  fileName?: string;
  contentType?: string;
  maxBytes?: number;
}

export type AttachmentDetectionErrorCode = "too_large" | "invalid_file";

export class AttachmentDetectionError extends Error {
  readonly code: AttachmentDetectionErrorCode;

  constructor(code: AttachmentDetectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentDetectionError";
    this.code = code;
  }
}

const IMAGE_FORMATS = new Map<string, { format: string; mimeType: string }>([
  ["jpg", { format: "jpg", mimeType: "image/jpeg" }],
  ["jpeg", { format: "jpg", mimeType: "image/jpeg" }],
  ["png", { format: "png", mimeType: "image/png" }],
  ["webp", { format: "webp", mimeType: "image/webp" }],
  ["gif", { format: "gif", mimeType: "image/gif" }],
  ["tif", { format: "tiff", mimeType: "image/tiff" }],
  ["tiff", { format: "tiff", mimeType: "image/tiff" }],
  ["bmp", { format: "bmp", mimeType: "image/bmp" }]
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "yaml", "yml",
  "html", "htm", "css", "scss", "sass", "less", "log", "toml", "ini", "cfg", "conf", "env",
  "properties", "sql", "graphql", "gql", "proto", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts",
  "tsx", "vue", "py", "pyw", "java", "kt", "kts", "go", "rs", "c", "cc", "cpp", "cxx", "h",
  "hh", "hpp", "hxx", "cs", "php", "rb", "swift", "scala", "sh", "bash", "zsh", "fish", "ps1",
  "r", "dart", "lua", "pl", "pm", "ex", "exs", "erl", "hrl", "fs", "fsx", "vb", "asm", "s",
  "sol", "gradle", "cmake"
]);

const TEXT_BASENAMES = new Set([
  "dockerfile", "makefile", "gemfile", "rakefile", "procfile", ".gitignore", ".gitattributes",
  ".editorconfig", ".env"
]);

const MODERN_OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods"]);
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "ppt", "xls"]);

export async function detectAttachmentType(
  filePath: string,
  options: DetectAttachmentOptions = {}
): Promise<DetectedAttachmentType> {
  const maxBytes = boundedMaxBytes(options.maxBytes);
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) {
    throw new AttachmentDetectionError("invalid_file", "Attachment input is not a regular file");
  }
  if (stats.size > maxBytes) {
    throw new AttachmentDetectionError("too_large", "File exceeds 256 MiB");
  }

  const fileName = options.fileName?.trim() || path.basename(filePath);
  const declaredExtension = extensionOf(fileName);
  const contentType = normalizeContentType(options.contentType);
  const textCandidate = isTextCandidate(fileName, contentType);
  const hasTextBom = textCandidate && await startsWithSupportedTextBom(filePath);
  const magic = hasTextBom ? undefined : await readMagicType(filePath);

  const directMagic = classifyDirectMagic(magic, declaredExtension);
  if (directMagic) return directMagic;

  if (isZipOfficeCandidate(magic, declaredExtension, contentType)) {
    const preflight = await preflightZipFile(filePath);
    const office = classifyZipOffice(
      preflight.officeKind,
      magic,
      declaredExtension,
      contentType
    );
    if (office) return office;
    return unsupportedResult(magic, declaredExtension, "ZIP container is not a confirmed supported Office file");
  }

  if (isCompoundFileMagic(magic)) {
    const legacy = classifyLegacyOffice(declaredExtension, contentType, magic!);
    if (legacy) return legacy;
    return unsupportedResult(magic, declaredExtension, "Compound file subtype could not be determined safely");
  }

  if (magic) {
    return unsupportedResult(magic, declaredExtension, "Detected binary format is not supported");
  }

  if (textCandidate) {
    try {
      const textEncoding = await detectTextEncoding(filePath, { maxBytes });
      const isUtf16 = textEncoding.encoding === "utf16le" || textEncoding.encoding === "utf16be";
      if (!isUtf16 && textEncoding.nulByteRatio > 0.01) {
        return unsupportedResult(undefined, declaredExtension, "Text candidate contains too many NUL bytes");
      }
      if (textEncoding.replacementRatio > 0.02 || textEncoding.controlRatio > 0.02) {
        return unsupportedResult(undefined, declaredExtension, "Text candidate is not reliably readable");
      }
      return {
        kind: "text",
        format: declaredExtension || "text",
        mimeType: contentType && isTextContentType(contentType) ? contentType : "text/plain",
        source: "text",
        declaredExtension: declaredExtension || undefined,
        extensionMismatch: false,
        textEncoding
      };
    } catch (error) {
      if (error instanceof TextExtractionError && error.code !== "too_large") {
        return unsupportedResult(undefined, declaredExtension, error.message);
      }
      throw error;
    }
  }

  return unsupportedResult(undefined, declaredExtension, "File type could not be determined safely");
}

export function isSupportedTextFileName(fileName: string) {
  const baseName = path.basename(fileName).toLowerCase();
  return TEXT_BASENAMES.has(baseName) || TEXT_EXTENSIONS.has(extensionOf(baseName));
}

function classifyDirectMagic(magic: FileTypeResult | undefined, declaredExtension: string) {
  if (!magic) return undefined;
  if (magic.ext === "pdf" || magic.mime === "application/pdf") {
    return detectedResult("pdf", "pdf", "application/pdf", "magic", magic, declaredExtension);
  }
  const image = IMAGE_FORMATS.get(magic.ext) ?? [...IMAGE_FORMATS.values()].find(
    (candidate) => candidate.mimeType === magic.mime
  );
  if (image) {
    return detectedResult("image", image.format, image.mimeType, "magic", magic, declaredExtension);
  }
  return undefined;
}

function classifyZipOffice(
  officeKind: ZipOfficeKind | undefined,
  magic: FileTypeResult | undefined,
  declaredExtension: string,
  contentType: string
) {
  if (officeKind === "docx") {
    return detectedResult(
      "document",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "container",
      magic,
      declaredExtension
    );
  }
  if (officeKind === "pptx") {
    return detectedResult(
      "presentation",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "container",
      magic,
      declaredExtension
    );
  }
  if (officeKind === "xlsx") {
    return detectedResult(
      "spreadsheet",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "container",
      magic,
      declaredExtension
    );
  }
  if (officeKind === "ambiguous") return undefined;
  if (officeKind === "open_document") {
    const format = odfFormat(magic?.ext) ?? odfFormat(declaredExtension) ?? odfFormatFromMime(contentType);
    if (format === "odt") {
      return detectedResult("document", "odt", "application/vnd.oasis.opendocument.text", "container", magic, declaredExtension);
    }
    if (format === "odp") {
      return detectedResult("presentation", "odp", "application/vnd.oasis.opendocument.presentation", "container", magic, declaredExtension);
    }
    if (format === "ods") {
      return detectedResult("spreadsheet", "ods", "application/vnd.oasis.opendocument.spreadsheet", "container", magic, declaredExtension);
    }
  }
  return undefined;
}

function classifyLegacyOffice(
  declaredExtension: string,
  contentType: string,
  magic: FileTypeResult
) {
  const format = LEGACY_OFFICE_EXTENSIONS.has(declaredExtension)
    ? declaredExtension
    : legacyFormatFromMime(contentType);
  if (format === "doc") {
    return detectedResult("document", "doc", "application/msword", "magic", magic, declaredExtension);
  }
  if (format === "ppt") {
    return detectedResult("presentation", "ppt", "application/vnd.ms-powerpoint", "magic", magic, declaredExtension);
  }
  if (format === "xls") {
    return detectedResult("spreadsheet", "xls", "application/vnd.ms-excel", "magic", magic, declaredExtension);
  }
  return undefined;
}

function detectedResult(
  kind: Exclude<AttachmentKind, "text" | "unsupported">,
  format: string,
  mimeType: string,
  source: "magic" | "container",
  magic: FileTypeResult | undefined,
  declaredExtension: string
): DetectedAttachmentType {
  return {
    kind,
    format,
    mimeType,
    source,
    declaredExtension: declaredExtension || undefined,
    detectedExtension: magic?.ext,
    extensionMismatch: Boolean(declaredExtension && !extensionsMatch(declaredExtension, format))
  };
}

function unsupportedResult(
  magic: FileTypeResult | undefined,
  declaredExtension: string,
  reason: string
): DetectedAttachmentType {
  return {
    kind: "unsupported",
    format: magic?.ext,
    mimeType: magic?.mime,
    source: magic ? "magic" : "none",
    declaredExtension: declaredExtension || undefined,
    detectedExtension: magic?.ext,
    extensionMismatch: Boolean(magic && declaredExtension && declaredExtension !== magic.ext),
    reason
  };
}

async function readMagicType(filePath: string) {
  try {
    return await fileTypeFromFile(filePath);
  } catch (error) {
    if (error instanceof Error && error.name === "EndOfStreamError") return undefined;
    throw error;
  }
}

async function startsWithSupportedTextBom(filePath: string) {
  const handle = await fsp.open(filePath, "r");
  try {
    const prefix = Buffer.alloc(3);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return (bytesRead >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) ||
      (bytesRead >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) ||
      (bytesRead >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff);
  } finally {
    await handle.close();
  }
}

function isZipOfficeCandidate(
  magic: FileTypeResult | undefined,
  declaredExtension: string,
  contentType: string
) {
  const magicExtension = magic?.ext ?? "";
  if (["docx", "pptx", "xlsx", "odt", "odp", "ods"].includes(magicExtension)) return true;
  if (magicExtension !== "zip" && magic?.mime !== "application/zip") return false;
  return MODERN_OFFICE_EXTENSIONS.has(declaredExtension) || isModernOfficeContentType(contentType);
}

function isCompoundFileMagic(magic: FileTypeResult | undefined) {
  return magic?.ext === "cfb" || magic?.mime === "application/x-cfb";
}

function isTextCandidate(fileName: string, contentType: string) {
  return isSupportedTextFileName(fileName) || isTextContentType(contentType);
}

function isTextContentType(contentType: string) {
  return contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/xml" ||
    contentType.endsWith("+xml") ||
    contentType === "application/javascript" ||
    contentType === "application/x-javascript" ||
    contentType === "application/x-ndjson" ||
    contentType === "application/yaml" ||
    contentType === "application/x-yaml" ||
    contentType === "application/sql";
}

function isModernOfficeContentType(contentType: string) {
  return contentType.startsWith("application/vnd.openxmlformats-officedocument.") ||
    contentType.startsWith("application/vnd.oasis.opendocument.");
}

function odfFormat(value: string | undefined) {
  return value === "odt" || value === "odp" || value === "ods" ? value : undefined;
}

function odfFormatFromMime(contentType: string) {
  if (contentType === "application/vnd.oasis.opendocument.text") return "odt";
  if (contentType === "application/vnd.oasis.opendocument.presentation") return "odp";
  if (contentType === "application/vnd.oasis.opendocument.spreadsheet") return "ods";
  return undefined;
}

function legacyFormatFromMime(contentType: string) {
  if (contentType === "application/msword") return "doc";
  if (contentType === "application/vnd.ms-powerpoint") return "ppt";
  if (contentType === "application/vnd.ms-excel") return "xls";
  return undefined;
}

function extensionsMatch(declaredExtension: string, format: string) {
  if (format === "jpg") return declaredExtension === "jpg" || declaredExtension === "jpeg";
  if (format === "tiff") return declaredExtension === "tif" || declaredExtension === "tiff";
  return declaredExtension === format;
}

function normalizeContentType(value: string | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  return extension.startsWith(".") ? extension.slice(1) : extension;
}

function boundedMaxBytes(value: number | undefined) {
  const resolved = value ?? MAX_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_ATTACHMENT_BYTES) {
    throw new RangeError(`maxBytes must be an integer between 1 and ${MAX_ATTACHMENT_BYTES}`);
  }
  return resolved;
}
