// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText, readChunksSqlite, StreamingTextChunker } from "../../services/media/attachments/chunks.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_INDEX_CHARACTERS,
  detectTextEncoding,
  extractTextFile,
  isAllowedAttachmentSize
} from "../../services/media/attachments/text.js";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-attachment-text-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("text encoding detection and extraction", () => {
  it("prioritizes BOM and extracts UTF-8 and both UTF-16 byte orders", async () => {
    const fixtures = [
      {
        name: "utf8.txt",
        bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("你好 UTF-8\n")]),
        encoding: "utf8",
        bomBytes: 3
      },
      {
        name: "utf16le.txt",
        bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode("你好 UTF-16LE\n", "utf16le")]),
        encoding: "utf16le",
        bomBytes: 2
      },
      {
        name: "utf16be.txt",
        bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode("你好 UTF-16BE\n", "utf16be")]),
        encoding: "utf16be",
        bomBytes: 2
      }
    ];

    for (const fixture of fixtures) {
      const filePath = path.join(temporaryDirectory, fixture.name);
      await fs.writeFile(filePath, fixture.bytes);
      const detection = await detectTextEncoding(filePath);
      expect(detection).toMatchObject({
        encoding: fixture.encoding,
        source: "bom",
        bomBytes: fixture.bomBytes,
        bytesScanned: fixture.bytes.length
      });

      const chunks: string[] = [];
      const result = await extractTextFile(filePath, {
        onChunk: (chunk) => chunks.push(chunk.text)
      });
      expect(chunks.join(""), fixture.name).toContain("你好");
      expect(result.encoding).toBe(fixture.encoding);
      expect(result.truncated).toBe(false);
      expect(result.replacementRatio).toBe(0);
    }
  });

  it("decodes GBK and GB18030 through bounded samples", async () => {
    const fixtures = [
      { name: "gbk.txt", text: "中文编码测试，天气晴朗。", encoding: "gbk" },
      { name: "gb18030.txt", text: "GB18030 扩展字符：𠀀。", encoding: "gb18030" }
    ];

    for (const fixture of fixtures) {
      const filePath = path.join(temporaryDirectory, fixture.name);
      await fs.writeFile(filePath, iconv.encode(fixture.text, fixture.encoding));
      const detection = await detectTextEncoding(filePath, { sampleBytes: 32 });
      expect(detection.sampleBytes).toBeLessThanOrEqual(32);
      expect(["gbk", "gb18030"]).toContain(detection.encoding);

      const chunks: string[] = [];
      const result = await extractTextFile(filePath, {
        encodingDetection: detection,
        onChunk: (chunk) => chunks.push(chunk.text)
      });
      expect(chunks.join("")).toBe(fixture.text);
      expect(result.characterCount).toBe(fixture.text.length);
    }
  });

  it("streams chunks to an atomic SQLite index and keeps source offsets", async () => {
    const text = "第一段内容比较长。\n\n第二段继续提供信息。\n第三行结束。";
    const filePath = path.join(temporaryDirectory, "paragraphs.txt");
    const outputPath = path.join(temporaryDirectory, "cache", "chunks.sqlite");
    await fs.writeFile(filePath, text, "utf8");

    const result = await extractTextFile(filePath, {
      outputPath,
      chunking: { maxCharacters: 14, overlapCharacters: 3 }
    });
    const chunks = readChunksSqlite(outputPath);

    expect(result.chunksWritten).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 14)).toBe(true);
    for (const chunk of chunks) {
      expect(text.slice(chunk.startChar, chunk.endChar)).toBe(chunk.text);
    }
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("produces the same paragraph-aware chunks regardless of decoder push boundaries", () => {
    const text = "alpha beta gamma\n\ndelta epsilon zeta eta theta";
    const expected = chunkText(text, { maxCharacters: 16, overlapCharacters: 3 });
    const chunker = new StreamingTextChunker({ maxCharacters: 16, overlapCharacters: 3 });
    const actual = [
      ...chunker.push(text.slice(0, 5)),
      ...chunker.push(text.slice(5, 21)),
      ...chunker.end(text.slice(21))
    ];
    expect(actual).toEqual(expected);
  });

  it("stops the index at the character boundary without leaving an unpaired surrogate", async () => {
    const filePath = path.join(temporaryDirectory, "truncated.txt");
    await fs.writeFile(filePath, "1234567890😀remaining", "utf8");
    const chunks: string[] = [];

    const result = await extractTextFile(filePath, {
      maxCharacters: 11,
      chunking: { maxCharacters: 8, overlapCharacters: 0 },
      onChunk: (chunk) => chunks.push(chunk.text)
    });

    expect(result).toMatchObject({ characterCount: 10, truncated: true });
    expect(chunks.join("")).toBe("1234567890");
    expect(chunks.join("")).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("keeps the 256 MiB and 20,000,000 character hard limits immutable", async () => {
    expect(isAllowedAttachmentSize(MAX_ATTACHMENT_BYTES)).toBe(true);
    expect(isAllowedAttachmentSize(MAX_ATTACHMENT_BYTES + 1)).toBe(false);

    const sparsePath = path.join(temporaryDirectory, "too-large.txt");
    const handle = await fs.open(sparsePath, "w");
    await handle.truncate(MAX_ATTACHMENT_BYTES + 1);
    await handle.close();
    await expect(detectTextEncoding(sparsePath)).rejects.toMatchObject({ code: "too_large" });

    const smallPath = path.join(temporaryDirectory, "small.txt");
    await fs.writeFile(smallPath, "ok", "utf8");
    await expect(extractTextFile(smallPath, {
      maxCharacters: MAX_TEXT_INDEX_CHARACTERS + 1
    })).rejects.toBeInstanceOf(RangeError);
    await expect(extractTextFile(smallPath, {
      maxBytes: MAX_ATTACHMENT_BYTES + 1
    })).rejects.toBeInstanceOf(RangeError);
  });
});
