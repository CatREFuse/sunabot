// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAttachmentType, isSupportedTextFileName } from "../../src/attachments/detect.js";
import { MAX_ATTACHMENT_BYTES } from "../../src/attachments/text.js";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-attachment-detect-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("attachment type detection", () => {
  it("uses binary magic ahead of a misleading extension and MIME type", async () => {
    const filePath = path.join(temporaryDirectory, "notes.txt");
    await fs.writeFile(filePath, "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "ascii");

    await expect(detectAttachmentType(filePath, {
      fileName: "notes.txt",
      contentType: "text/plain"
    })).resolves.toMatchObject({
      kind: "pdf",
      format: "pdf",
      source: "magic",
      extensionMismatch: true,
      declaredExtension: "txt",
      detectedExtension: "pdf"
    });
  });

  it("recognizes supported image magic", async () => {
    const filePath = path.join(temporaryDirectory, "picture.dat");
    await fs.writeFile(filePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    ));
    await expect(detectAttachmentType(filePath)).resolves.toMatchObject({
      kind: "image",
      format: "png",
      mimeType: "image/png",
      source: "magic"
    });
  });

  it("confirms OOXML subtype from container entries", async () => {
    const filePath = path.join(temporaryDirectory, "misnamed.xlsx");
    await writeEmptyStoredZip(filePath, ["[Content_Types].xml", "word/document.xml"]);

    await expect(detectAttachmentType(filePath, { fileName: "misnamed.xlsx" })).resolves.toMatchObject({
      kind: "document",
      format: "docx",
      source: "container",
      declaredExtension: "xlsx",
      extensionMismatch: true
    });
  });

  it("uses the extension or MIME only to subtype confirmed legacy compound files", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504)
    ]);
    const pptPath = path.join(temporaryDirectory, "slides.ppt");
    await fs.writeFile(pptPath, bytes);
    await expect(detectAttachmentType(pptPath)).resolves.toMatchObject({
      kind: "presentation",
      format: "ppt",
      source: "magic"
    });

    const mimePath = path.join(temporaryDirectory, "legacy.bin");
    await fs.writeFile(mimePath, bytes);
    await expect(detectAttachmentType(mimePath, {
      contentType: "application/vnd.ms-excel"
    })).resolves.toMatchObject({
      kind: "spreadsheet",
      format: "xls",
      source: "magic"
    });
  });

  it("accepts whitelisted text and source names only when decoded content is plausible", async () => {
    const utf16Path = path.join(temporaryDirectory, "data.json");
    await fs.writeFile(
      utf16Path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('{"名称":"测试"}', "utf16le")])
    );
    await expect(detectAttachmentType(utf16Path)).resolves.toMatchObject({
      kind: "text",
      format: "json",
      source: "text",
      textEncoding: { encoding: "utf16le", source: "bom" }
    });

    const extensionlessPath = path.join(temporaryDirectory, "payload");
    await fs.writeFile(extensionlessPath, "plain response", "utf8");
    await expect(detectAttachmentType(extensionlessPath, {
      contentType: "text/plain; charset=utf-8"
    })).resolves.toMatchObject({ kind: "text", mimeType: "text/plain" });

    const binaryPath = path.join(temporaryDirectory, "binary.txt");
    await fs.writeFile(binaryPath, Buffer.alloc(4_096));
    await expect(detectAttachmentType(binaryPath)).resolves.toMatchObject({
      kind: "unsupported",
      reason: "Text candidate contains too many NUL bytes"
    });
  });

  it("does not promote a generic ZIP or an extension-only binary claim", async () => {
    const zipPath = path.join(temporaryDirectory, "archive.zip");
    await writeEmptyStoredZip(zipPath, ["readme.txt"]);
    await expect(detectAttachmentType(zipPath)).resolves.toMatchObject({
      kind: "unsupported",
      detectedExtension: "zip"
    });

    const fakePdfPath = path.join(temporaryDirectory, "fake.pdf");
    await fs.writeFile(fakePdfPath, "ordinary text with the wrong extension", "utf8");
    await expect(detectAttachmentType(fakePdfPath)).resolves.toMatchObject({ kind: "unsupported" });
  });

  it("covers common source names and rejects an input larger than 256 MiB before inspection", async () => {
    expect(isSupportedTextFileName("Dockerfile")).toBe(true);
    expect(isSupportedTextFileName("src/main.ts")).toBe(true);
    expect(isSupportedTextFileName("unknown.bin")).toBe(false);

    const filePath = path.join(temporaryDirectory, "too-large.txt");
    const handle = await fs.open(filePath, "w");
    await handle.truncate(MAX_ATTACHMENT_BYTES + 1);
    await handle.close();
    await expect(detectAttachmentType(filePath)).rejects.toMatchObject({ code: "too_large" });
  });
});

async function writeEmptyStoredZip(filePath: string, entryNames: string[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entryName of entryNames) {
    const name = Buffer.from(entryName, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryNames.length, 8);
  end.writeUInt16LE(entryNames.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  await fs.writeFile(filePath, Buffer.concat([...localParts, ...centralParts, end]));
}
