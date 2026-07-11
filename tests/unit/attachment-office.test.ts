// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  convertPresentationToPdf,
  extractOfficeText
} from "../../services/media/attachments/office.js";
import { extractPdfTextByPage } from "../../services/media/attachments/pdf.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("Office attachment processing", () => {
  it("extracts PowerPoint text with slide boundaries", async () => {
    const { pptxPath } = await createPresentationFixture();

    const result = await extractOfficeText(pptxPath);

    expect(result.fileType).toBe("pptx");
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({ kind: "slide", title: "幻灯片 1" });
    expect(result.sections[0]?.text).toContain("季度收入增长");
    expect(result.sections[1]?.text).toContain("现金流保持稳定");
  }, 30_000);

  it("converts PowerPoint to a multi-page PDF for visual understanding", async () => {
    const { directory, pptxPath } = await createPresentationFixture();
    const outputDir = path.join(directory, "pdf");

    const converted = await convertPresentationToPdf(pptxPath, outputDir);
    const pdf = await extractPdfTextByPage(converted.outputPath);

    expect(pdf.pageCount).toBe(2);
    expect(pdf.pages[0]?.text).toContain("季度收入增长");
    expect(pdf.pages[1]?.text).toContain("现金流保持稳定");
  }, 45_000);
});

async function createPresentationFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sunabot-pptx-test-"));
  temporaryDirectories.push(directory);
  const pptxPath = path.join(directory, "季度报告.pptx");
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "sunabot test";
  presentation.subject = "QQ 文件读取";
  const first = presentation.addSlide();
  first.addText("季度收入增长", { x: 0.8, y: 0.8, w: 7, h: 0.8, fontSize: 28 });
  first.addText("华东区域同比增长 26%", { x: 0.8, y: 2, w: 7, h: 0.6, fontSize: 18 });
  const second = presentation.addSlide();
  second.addText("现金流保持稳定", { x: 0.8, y: 0.8, w: 7, h: 0.8, fontSize: 28 });
  second.addText("经营现金流为 3200 万元", { x: 0.8, y: 2, w: 7, h: 0.6, fontSize: 18 });
  await presentation.writeFile({ fileName: pptxPath });
  return { directory, pptxPath };
}
