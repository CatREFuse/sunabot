// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  convertWithLibreOffice,
  findLibreOffice
} from "../../services/media/attachments/libreoffice.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("LibreOffice integration", () => {
  it("detects the installed headless executable", async () => {
    const info = await findLibreOffice();
    expect(info?.executable).toBeTruthy();
    expect(info?.version).toMatch(/LibreOffice/i);
  }, 30_000);

  it("converts a text fixture to a real PDF in a controlled output directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sunabot-lo-test-"));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, "中文资料.txt");
    const outputDir = path.join(directory, "output");
    await writeFile(inputPath, "QQ 文件读取 LibreOffice 转换测试\n第二行内容", "utf8");

    const result = await convertWithLibreOffice(inputPath, outputDir);
    const bytes = await readFile(result.outputPath);

    expect(result.outputPath).toBe(path.join(outputDir, "中文资料.pdf"));
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(500);
  }, 60_000);
});
