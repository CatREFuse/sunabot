// @vitest-environment node
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AttachmentResolutionError,
  extractAttachmentSource,
  resolveAttachmentSource,
  type FileActionGateway
} from "../../src/attachments/resolver.js";

describe("attachment source resolver", () => {
  it("uses a message HTTP URL without calling NapCat", async () => {
    const sendAction = vi.fn();
    const url = "https://cdn.example.test/file?id=1&token=signed";

    await expect(resolveAttachmentSource({ url, fileId: "file-1" }, { sendAction }))
      .resolves.toEqual({ kind: "url", url, via: "message" });
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("resolves a group file URL with group, file and bus IDs", async () => {
    const sendAction = vi.fn(async () => ({
      status: "ok",
      data: { url: "https://cdn.example.test/group-file" }
    }));

    await expect(resolveAttachmentSource({
      groupId: 123,
      fileId: "group-file-id",
      busId: 456
    }, { sendAction })).resolves.toEqual({
      kind: "url",
      url: "https://cdn.example.test/group-file",
      via: "get_group_file_url"
    });
    expect(sendAction).toHaveBeenCalledOnce();
    expect(sendAction).toHaveBeenCalledWith("get_group_file_url", {
      group_id: 123,
      file_id: "group-file-id",
      busid: 456
    });
  });

  it("resolves private files through get_private_file_url", async () => {
    const sendAction = vi.fn(async () => ({
      data: { file_url: "http://127.0.0.1:3000/private-file" }
    }));

    await expect(resolveAttachmentSource({ fileId: "private-file-id" }, { sendAction }))
      .resolves.toEqual({
        kind: "url",
        url: "http://127.0.0.1:3000/private-file",
        via: "get_private_file_url"
      });
    expect(sendAction).toHaveBeenCalledWith("get_private_file_url", {
      file_id: "private-file-id"
    });
  });

  it("falls back from URL actions to get_file Base64", async () => {
    const sendAction = vi.fn(async (action: string) => {
      if (action === "get_group_file_url") throw new Error("not available");
      return { data: { base64: "aGVsbG8=" } };
    });

    await expect(resolveAttachmentSource({ groupId: 123, fileId: "file-1" }, {
      sendAction
    })).resolves.toEqual({
      kind: "base64",
      base64: "aGVsbG8=",
      via: "get_file"
    });
    expect(sendAction.mock.calls).toEqual([
      ["get_group_file_url", { group_id: 123, file_id: "file-1" }],
      ["get_file", { file_id: "file-1" }]
    ]);
  });

  it("passes the raw file value to get_file when no file ID exists", async () => {
    const sharedRoot = path.resolve("/shared/napcat");
    const sendAction = vi.fn(async () => ({
      data: { file: path.join(sharedRoot, "downloads", "report.pdf") }
    }));

    await expect(resolveAttachmentSource({ file: "report.pdf" }, { sendAction }, {
      sharedRoots: [sharedRoot]
    })).resolves.toEqual({
      kind: "shared_path",
      filePath: path.join(sharedRoot, "downloads", "report.pdf"),
      via: "get_file"
    });
    expect(sendAction).toHaveBeenCalledWith("get_file", { file: "report.pdf" });
  });

  it("rejects local paths outside configured shared roots", async () => {
    const sendAction = vi.fn(async () => ({
      data: { file: "/container/private/report.pdf" }
    }));

    const promise = resolveAttachmentSource({ fileId: "file-1" }, { sendAction }, {
      sharedRoots: ["/shared/napcat"]
    });

    await expect(promise).rejects.toBeInstanceOf(AttachmentResolutionError);
    await expect(promise).rejects.toEqual(expect.objectContaining({
      attempts: [
        { action: "get_private_file_url", outcome: "empty" },
        { action: "get_file", outcome: "empty" }
      ]
    }));
  });

  it("recognizes supported action response shapes only", () => {
    expect(extractAttachmentSource({ data: "base64://aGVsbG8=" }))
      .toEqual({ kind: "base64", base64: "aGVsbG8=" });
    expect(extractAttachmentSource({
      url: "data:application/octet-stream;base64,aGVsbG8="
    })).toEqual({
      kind: "base64",
      base64: "data:application/octet-stream;base64,aGVsbG8="
    });
    expect(extractAttachmentSource({ data: { url: "ftp://example.test/file" } }))
      .toBeUndefined();
    expect(extractAttachmentSource({ data: { path: "/shared/../private/file" } }, {
      sharedRoots: ["/shared"]
    })).toBeUndefined();
  });

  it("reports each exhausted fallback without leaking action errors", async () => {
    const gateway: FileActionGateway = {
      sendAction: vi.fn(async (action) => {
        if (action === "get_private_file_url") return { data: {} };
        throw new Error("secret upstream detail");
      })
    };

    const error = await resolveAttachmentSource({ fileId: "file-1" }, gateway)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AttachmentResolutionError);
    expect(error).toMatchObject({
      attempts: [
        { action: "get_private_file_url", outcome: "empty" },
        { action: "get_file", outcome: "error" }
      ]
    });
    expect(String(error)).not.toContain("secret upstream detail");
  });
});
