// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractPdfTextByPage,
  renderPdfPages,
  renderPdfPagesBestEffort
} from "../../src/attachments/pdf.js";
import { CacheStore } from "../../src/attachments/cache.js";
import { AttachmentService } from "../../src/attachments/service.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("PDF attachment processing", () => {
  it("extracts text page by page from a generated PDF", async () => {
    const pdf = createTextPdf(["First page revenue", "Second page cash flow"]);

    const result = await extractPdfTextByPage(pdf);

    expect(result.pageCount).toBe(2);
    expect(result.pages).toEqual([
      { pageNumber: 1, text: "First page revenue" },
      { pageNumber: 2, text: "Second page cash flow" }
    ]);
    expect(result.textCharacterCount).toBe("First page revenue".length + "Second page cash flow".length);
  });

  it("marks extraction as truncated when maxCharacters cuts the PDF text", async () => {
    const result = await extractPdfTextByPage(
      createTextPdf(["First page revenue", "Second page cash flow"]),
      { maxCharacters: 5 }
    );

    expect(result).toMatchObject({
      pageCount: 2,
      pages: [{ pageNumber: 1, text: "First" }],
      textCharacterCount: 5,
      truncated: true
    });
  });

  it("renders unique requested pages from a generated temporary fixture", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-pdf-test-"));
    const filePath = path.join(temporaryDirectory, "fixture.pdf");
    await fs.writeFile(filePath, createTextPdf(["First", "Second"]));

    const pages = await renderPdfPages(filePath, [2, 2], { maxLongEdge: 320, scale: 2 });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ pageNumber: 2, contentType: "image/png" });
    expect(Math.max(pages[0]!.width, pages[0]!.height)).toBeLessThanOrEqual(320);
    expect(pages[0]!.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("rejects a page outside the document", async () => {
    await expect(renderPdfPages(createTextPdf(["Only page"]), [2])).rejects.toThrow("outside 1-1");
  });

  it("keeps successful pages when another requested page fails", async () => {
    const result = await renderPdfPagesBestEffort(
      createTextPdf(["First", "Second"]),
      [1, 3, 2, 1],
      { maxLongEdge: 320 }
    );

    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.failures).toEqual([
      expect.objectContaining({ pageNumber: 3, error: expect.stringContaining("outside 1-2") })
    ]);
    expect(result.pages.every((page) => page.bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    ))).toBe(true);
  });

  it("publishes successful visual pages when one worker page fails", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-pdf-service-test-"));
    const cacheRoot = path.join(temporaryDirectory, "file-cache");
    const sourcePath = path.join(temporaryDirectory, "source.pdf");
    await fs.writeFile(sourcePath, createTextPdf(["First", "Second"]));
    const cacheStore = new CacheStore(cacheRoot, { minimumFreeBytes: 0 });
    const cached = await cacheStore.importFile(sourcePath);
    const cacheKey = cached.cacheKey;
    const artifactsDir = path.join(cacheRoot, cacheKey, "artifacts");
    const visualSourcePath = path.join(artifactsDir, "visual-source.pdf");
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.copyFile(sourcePath, visualSourcePath);
    const service = new AttachmentService(temporaryDirectory, { cacheRoot, cacheStore });

    const context = await service.buildModelContext([{
      id: "pdf-attachment",
      source: "message",
      name: "fixture.pdf",
      status: "partial",
      mimeType: "application/pdf",
      format: "pdf",
      sha256: cacheKey,
      cacheKey,
      visualSourcePath: path.relative(cacheRoot, visualSourcePath),
      pageCount: 3
    }]);

    expect(context.localImagePaths).toHaveLength(2);
    expect(context.localImagePaths.map((filePath) => path.basename(filePath)).sort()).toEqual([
      "page-1.png",
      "page-2.png"
    ]);
    await expect(Promise.all(context.localImagePaths.map((filePath) => fs.stat(filePath))))
      .resolves.toHaveLength(2);
    expect(context.attachments[0]).toMatchObject({
      status: "partial",
      errorCode: "visual_unavailable"
    });
  }, 30_000);
});

function createTextPdf(pageTexts: string[]) {
  const objects: Array<string | undefined> = [undefined];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageObjectNumbers: number[] = [];
  const fontObjectNumber = 3 + pageTexts.length * 2;
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    pageObjectNumbers.push(pageObjectNumber);
    const content = `BT /F1 18 Tf 30 120 Td (${escapePdfString(pageTexts[index]!)}) Tj ET`;
    objects[pageObjectNumber] = [
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]",
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >>`,
      `/Contents ${contentObjectNumber} 0 R >>`
    ].join(" ");
    objects[contentObjectNumber] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = Buffer.byteLength(pdf);
    pdf += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number += 1) {
    pdf += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function escapePdfString(value: string) {
  return value.replace(/([\\()])/g, "\\$1");
}
