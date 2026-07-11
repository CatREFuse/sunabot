// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_CONTEXT_CHARACTERS,
  MAX_ATTACHMENT_VISUAL_PAGES,
  rankAttachmentChunks,
  selectAttachmentContext
} from "../../src/attachments/context.js";
import type { AttachmentTextChunk } from "../../src/attachments/chunks.js";

describe("attachment context selection", () => {
  it("ranks relevant text and keeps the shared character budget", () => {
    const filler = "x".repeat(80_000);
    const result = selectAttachmentContext([
      {
        attachmentId: "a",
        name: "report.pdf",
        chunks: [chunk(0, filler, 1), chunk(1, "Cash flow improved sharply", 8)],
        pageCount: 20
      },
      {
        attachmentId: "b",
        name: "notes.txt",
        chunks: [chunk(0, filler, 1)]
      }
    ], "cash flow");

    expect(result.characterCount).toBe(MAX_ATTACHMENT_CONTEXT_CHARACTERS);
    expect(result.textTruncated).toBe(true);
    expect(result.textChunks[0]).toMatchObject({ attachmentId: "a", chunk: { index: 1, pageNumber: 8 } });
    expect(result.textChunks.some((selected) => selected.attachmentId === "b")).toBe(true);
  });

  it("keeps page one and selects pages related to the question within twelve pages", () => {
    const chunks = Array.from({ length: 20 }, (_value, index) =>
      chunk(index, index === 16 ? "The acquisition risk is discussed here" : `General page ${index + 1}`, index + 1)
    );

    const result = selectAttachmentContext([{ attachmentId: "a", name: "deal.pdf", chunks, pageCount: 20 }], "acquisition risk");

    expect(result.visualPages).toHaveLength(MAX_ATTACHMENT_VISUAL_PAGES);
    expect(result.visualPages[0]?.pageNumber).toBe(1);
    expect(result.visualPages.map((page) => page.pageNumber)).toContain(17);
    expect(result.visualTruncated).toBe(true);
  });

  it("uses PPT slide numbers to select a relevant twentieth slide", () => {
    const chunks = Array.from({ length: 20 }, (_value, index) => ({
      ...chunk(index, index === 19 ? "The launch decision is on this slide" : `General slide ${index + 1}`),
      slideNumber: index + 1
    }));

    const result = selectAttachmentContext([
      { attachmentId: "deck", name: "launch.pptx", chunks, pageCount: 20 }
    ], "launch decision");

    expect(result.visualPages[0]).toMatchObject({ attachmentId: "deck", pageNumber: 1 });
    expect(result.visualPages.map((page) => page.pageNumber)).toContain(20);
    expect(result.visualPages).toHaveLength(MAX_ATTACHMENT_VISUAL_PAGES);
  });

  it("bounds visual candidates for an extremely large page count", () => {
    const result = selectAttachmentContext([
      {
        attachmentId: "huge",
        name: "huge.pdf",
        chunks: [],
        pageCount: Number.MAX_SAFE_INTEGER
      }
    ], "", { maxVisualPages: Number.MAX_SAFE_INTEGER });

    expect(result.visualPages).toHaveLength(MAX_ATTACHMENT_VISUAL_PAGES);
    expect(result.visualPages.map((page) => page.pageNumber)).toEqual(
      Array.from({ length: MAX_ATTACHMENT_VISUAL_PAGES }, (_value, index) => index + 1)
    );
    expect(result.visualTruncated).toBe(true);
  });

  it("shares visual pages across attachments and caps caller-provided limits", () => {
    const result = selectAttachmentContext([
      { attachmentId: "a", name: "a.pdf", chunks: [], pageCount: 20 },
      { attachmentId: "b", name: "b.pdf", chunks: [], pageCount: 20 }
    ], "", { maxCharacters: 999_999, maxVisualPages: 999 });

    expect(result.characterCount).toBe(0);
    expect(result.visualPages).toHaveLength(MAX_ATTACHMENT_VISUAL_PAGES);
    expect(result.visualPages.slice(0, 2).map((page) => [page.attachmentId, page.pageNumber])).toEqual([
      ["a", 1],
      ["b", 1]
    ]);
    expect(Math.max(...result.visualPages.map((page) => page.pageNumber))).toBe(6);
  });

  it("uses document order when there is no useful query", () => {
    const chunks = [chunk(0, "first", 1), chunk(1, "second", 2)];
    expect(rankAttachmentChunks([{ attachmentId: "a", name: "a.pdf", chunks }], "").map((item) => item.chunk.index))
      .toEqual([0, 1]);
  });
});

function chunk(index: number, text: string, pageNumber?: number): AttachmentTextChunk {
  return {
    index,
    text,
    startChar: 0,
    endChar: text.length,
    pageNumber
  };
}
