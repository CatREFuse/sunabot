// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  preflightZipFile
} from "../../services/media/attachments/zipPreflight.js";

interface TestZipEntry {
  name: string;
  uncompressedSize?: number;
}

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-zip-preflight-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("ZIP central-directory preflight", () => {
  it("recognizes bounded OOXML and OpenDocument container markers", async () => {
    const fixtures = [
      {
        name: "docx.zip",
        entries: ["[Content_Types].xml", "word/document.xml"],
        officeKind: "docx"
      },
      {
        name: "pptx.zip",
        entries: ["[Content_Types].xml", "ppt/presentation.xml"],
        officeKind: "pptx"
      },
      {
        name: "xlsx.zip",
        entries: ["[Content_Types].xml", "xl/workbook.xml"],
        officeKind: "xlsx"
      },
      {
        name: "odf.zip",
        entries: ["mimetype", "content.xml", "META-INF/manifest.xml"],
        officeKind: "open_document"
      }
    ];

    for (const fixture of fixtures) {
      const filePath = path.join(temporaryDirectory, fixture.name);
      await writeStoredZip(filePath, fixture.entries.map((name) => ({ name })));
      await expect(preflightZipFile(filePath)).resolves.toMatchObject({
        entryCount: fixture.entries.length,
        totalUncompressedBytes: 0,
        officeKind: fixture.officeKind
      });
    }
  });

  it("accepts every exact ZIP boundary", async () => {
    const entryPath = path.join(temporaryDirectory, "entry-boundary.zip");
    await writeStoredZip(entryPath, [{
      name: "large.bin",
      uncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
    }]);
    await expect(preflightZipFile(entryPath)).resolves.toMatchObject({
      entryCount: 1,
      totalUncompressedBytes: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
    });

    const totalPath = path.join(temporaryDirectory, "total-boundary.zip");
    await writeStoredZip(totalPath, Array.from({ length: 4 }, (_, index) => ({
      name: `${index}.bin`,
      uncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
    })));
    await expect(preflightZipFile(totalPath)).resolves.toMatchObject({
      entryCount: 4,
      totalUncompressedBytes: MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES
    });

    const countPath = path.join(temporaryDirectory, "count-boundary.zip");
    await writeStoredZip(countPath, Array.from({ length: MAX_ZIP_ENTRIES }, (_, index) => ({
      name: `${index}.txt`
    })));
    await expect(preflightZipFile(countPath)).resolves.toMatchObject({
      entryCount: MAX_ZIP_ENTRIES,
      totalUncompressedBytes: 0
    });
  }, 20_000);

  it("rejects entry count, individual size and aggregate size one unit above the limits", async () => {
    const countPath = path.join(temporaryDirectory, "too-many.zip");
    await writeStoredZip(countPath, Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => ({
      name: `${index}.txt`
    })));
    await expect(preflightZipFile(countPath)).rejects.toMatchObject({
      code: "zip_entry_count_exceeded"
    });

    const entryPath = path.join(temporaryDirectory, "entry-too-large.zip");
    await writeStoredZip(entryPath, [{
      name: "large.bin",
      uncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1
    }]);
    await expect(preflightZipFile(entryPath)).rejects.toMatchObject({
      code: "zip_entry_uncompressed_exceeded"
    });

    const totalPath = path.join(temporaryDirectory, "total-too-large.zip");
    await writeStoredZip(totalPath, [
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `${index}.bin`,
        uncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
      })),
      { name: "overflow.bin", uncompressedSize: 1 }
    ]);
    await expect(preflightZipFile(totalPath)).rejects.toMatchObject({
      code: "zip_total_uncompressed_exceeded"
    });
  }, 20_000);

  it("marks conflicting OOXML roots as ambiguous", async () => {
    const filePath = path.join(temporaryDirectory, "ambiguous.zip");
    await writeStoredZip(filePath, [
      { name: "[Content_Types].xml" },
      { name: "word/document.xml" },
      { name: "ppt/presentation.xml" }
    ]);
    await expect(preflightZipFile(filePath)).resolves.toMatchObject({ officeKind: "ambiguous" });
  });

  it("normalizes malformed archives and unsafe names to invalid_zip", async () => {
    const malformedPath = path.join(temporaryDirectory, "malformed.zip");
    await fs.writeFile(malformedPath, "not a zip", "utf8");
    await expect(preflightZipFile(malformedPath)).rejects.toMatchObject({ code: "invalid_zip" });

    const unsafePath = path.join(temporaryDirectory, "unsafe.zip");
    await writeStoredZip(unsafePath, [{ name: "../escape.txt" }]);
    await expect(preflightZipFile(unsafePath)).rejects.toMatchObject({ code: "invalid_zip" });
  });
});

async function writeStoredZip(filePath: string, entries: TestZipEntry[]) {
  if (entries.length > 0xffff) throw new Error("Test ZIP exceeds classic ZIP entry-count field");
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const declaredSize = entry.uncompressedSize ?? 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(declaredSize, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(declaredSize, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(filePath, Buffer.concat([...localParts, ...centralParts, end]));
}
