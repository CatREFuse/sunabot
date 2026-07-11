import yauzl from "yauzl";

export const MAX_ZIP_ENTRIES = 20_000;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export type ZipOfficeKind = "docx" | "pptx" | "xlsx" | "open_document" | "ambiguous";

export type ZipPreflightErrorCode =
  | "invalid_zip"
  | "zip_entry_count_exceeded"
  | "zip_total_uncompressed_exceeded"
  | "zip_entry_uncompressed_exceeded";

export class ZipPreflightError extends Error {
  readonly code: ZipPreflightErrorCode;

  constructor(code: ZipPreflightErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZipPreflightError";
    this.code = code;
  }
}

export interface ZipPreflightLimits {
  maxEntries?: number;
  maxTotalUncompressedBytes?: number;
  maxEntryUncompressedBytes?: number;
}

export interface ZipOfficeMarkers {
  contentTypes: boolean;
  wordDocument: boolean;
  presentation: boolean;
  workbook: boolean;
  openDocumentContent: boolean;
  openDocumentManifest: boolean;
  mimetype: boolean;
}

export interface ZipPreflightResult {
  entryCount: number;
  totalUncompressedBytes: number;
  officeKind?: ZipOfficeKind;
  markers: ZipOfficeMarkers;
}

/**
 * Reads only the ZIP central directory. It never inflates or buffers entry bodies.
 */
export async function preflightZipFile(
  filePath: string,
  limits: ZipPreflightLimits = {}
): Promise<ZipPreflightResult> {
  const maxEntries = positiveSafeInteger(limits.maxEntries, MAX_ZIP_ENTRIES, "maxEntries");
  const maxTotalUncompressedBytes = positiveSafeInteger(
    limits.maxTotalUncompressedBytes,
    MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
    "maxTotalUncompressedBytes"
  );
  const maxEntryUncompressedBytes = positiveSafeInteger(
    limits.maxEntryUncompressedBytes,
    MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    "maxEntryUncompressedBytes"
  );

  let zipFile: yauzl.ZipFile;
  try {
    zipFile = await yauzl.openPromise(filePath, {
      autoClose: true,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    });
  } catch (error) {
    throw invalidZipError(error);
  }

  try {
    if (!Number.isSafeInteger(zipFile.entryCount) || zipFile.entryCount < 0) {
      throw new ZipPreflightError("invalid_zip", "ZIP entry count is invalid");
    }
    if (zipFile.entryCount > maxEntries) {
      throw new ZipPreflightError(
        "zip_entry_count_exceeded",
        `ZIP contains more than ${maxEntries} entries`
      );
    }

    let entryCount = 0;
    let totalUncompressedBytes = 0;
    const markers = emptyOfficeMarkers();

    for await (const entry of zipFile.eachEntry()) {
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new ZipPreflightError(
          "zip_entry_count_exceeded",
          `ZIP contains more than ${maxEntries} entries`
        );
      }

      const size = entry.uncompressedSize;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new ZipPreflightError("invalid_zip", "ZIP entry has an invalid declared size");
      }
      if (size > maxEntryUncompressedBytes) {
        throw new ZipPreflightError(
          "zip_entry_uncompressed_exceeded",
          `ZIP entry exceeds ${maxEntryUncompressedBytes} declared bytes`
        );
      }
      if (totalUncompressedBytes > maxTotalUncompressedBytes - size) {
        throw new ZipPreflightError(
          "zip_total_uncompressed_exceeded",
          `ZIP declared uncompressed size exceeds ${maxTotalUncompressedBytes} bytes`
        );
      }
      totalUncompressedBytes += size;
      recordOfficeMarker(markers, entry.fileName);
    }

    return {
      entryCount,
      totalUncompressedBytes,
      officeKind: officeKindFromMarkers(markers),
      markers
    };
  } catch (error) {
    if (error instanceof ZipPreflightError) throw error;
    throw invalidZipError(error);
  } finally {
    if (zipFile.isOpen) zipFile.close();
  }
}

function emptyOfficeMarkers(): ZipOfficeMarkers {
  return {
    contentTypes: false,
    wordDocument: false,
    presentation: false,
    workbook: false,
    openDocumentContent: false,
    openDocumentManifest: false,
    mimetype: false
  };
}

function recordOfficeMarker(markers: ZipOfficeMarkers, fileName: string) {
  const normalized = fileName.replace(/^\.\//u, "").toLowerCase();
  if (normalized === "[content_types].xml") markers.contentTypes = true;
  if (normalized === "word/document.xml") markers.wordDocument = true;
  if (normalized === "ppt/presentation.xml") markers.presentation = true;
  if (normalized === "xl/workbook.xml") markers.workbook = true;
  if (normalized === "content.xml") markers.openDocumentContent = true;
  if (normalized === "meta-inf/manifest.xml") markers.openDocumentManifest = true;
  if (normalized === "mimetype") markers.mimetype = true;
}

function officeKindFromMarkers(markers: ZipOfficeMarkers): ZipOfficeKind | undefined {
  const ooxmlKinds: ZipOfficeKind[] = [];
  if (markers.contentTypes && markers.wordDocument) ooxmlKinds.push("docx");
  if (markers.contentTypes && markers.presentation) ooxmlKinds.push("pptx");
  if (markers.contentTypes && markers.workbook) ooxmlKinds.push("xlsx");
  if (ooxmlKinds.length > 1) return "ambiguous";
  if (ooxmlKinds.length === 1) return ooxmlKinds[0];
  if (markers.openDocumentContent && markers.openDocumentManifest && markers.mimetype) {
    return "open_document";
  }
  return undefined;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function invalidZipError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return new ZipPreflightError("invalid_zip", `Invalid ZIP: ${message}`, {
    cause: error
  });
}
