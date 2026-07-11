// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AttachmentService } from "../../src/attachments/service.js";
import type { ParsedAttachment } from "../../src/attachments/types.js";

describe("AttachmentService in-memory parse reuse", () => {
  it("keeps only the 512 most recently used parsed results", () => {
    const service = new AttachmentService("/tmp/sunabot-attachment-memory-test");
    const internal = service as unknown as {
      parsedByReuseKey: Map<string, ParsedAttachment>;
      getParsedResult(key: string): ParsedAttachment | undefined;
      rememberParsedResult(key: string, attachment: ParsedAttachment): void;
    };

    for (let index = 0; index < 512; index += 1) {
      internal.rememberParsedResult(`entry-${index}`, parsedAttachment(index));
    }
    expect(internal.getParsedResult("entry-0")?.name).toBe("file-0.txt");

    internal.rememberParsedResult("entry-512", parsedAttachment(512));

    expect(internal.parsedByReuseKey.size).toBe(512);
    expect(internal.parsedByReuseKey.has("entry-0")).toBe(true);
    expect(internal.parsedByReuseKey.has("entry-1")).toBe(false);
    expect(internal.parsedByReuseKey.has("entry-512")).toBe(true);
  });
});

function parsedAttachment(index: number): ParsedAttachment {
  return {
    id: `attachment-${index}`,
    source: "message",
    name: `file-${index}.txt`,
    status: "ready"
  };
}
