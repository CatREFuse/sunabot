import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelfieReferenceImage, SelfieReferencePayload } from "../types";
import { normalizeSelfieReferenceNote, useSelfieReferences } from "./useSelfieReferences";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

const image: SelfieReferenceImage = {
  id: "a".repeat(64),
  fileName: "01-neutral-face.png",
  note: "日常服",
  sizeBytes: 240_000,
  width: 458,
  height: 501,
  updatedAt: "2026-07-12T10:00:00.000Z",
  originalUrl: "/api/selfie-references/01-neutral-face.png/content?variant=original",
  displayUrl: "/api/selfie-references/01-neutral-face.png/content?variant=display",
  placeholderUrl: "/api/selfie-references/01-neutral-face.png/content?variant=placeholder"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("useSelfieReferences", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads, uploads, and removes reference images", async () => {
    const empty: SelfieReferencePayload = { images: [], maxImages: 9 };
    const editedImage = { ...image, note: "泳装" };
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/selfie-references?agentId=plana" && !init?.method) return Promise.resolve(empty);
      if (path === "/api/selfie-references?agentId=plana" && init?.method === "POST") return Promise.resolve({ images: [image], maxImages: 9 });
      if (path === `/api/selfie-references/${image.id}?agentId=plana` && init?.method === "PATCH") return Promise.resolve({ images: [editedImage], maxImages: 9 });
      if (path === `/api/selfie-references/${image.id}?agentId=plana` && init?.method === "DELETE") return Promise.resolve(undefined);
      throw new Error(`Unexpected request: ${path}`);
    });
    const references = useSelfieReferences();

    expect(references.maxImages.value).toBe(9);
    await references.load("plana");
    const file = new File(["png"], "plana.png", { type: "image/png" });
    const saved = await references.upload("plana", [{ file, note: " 女仆装 " }]);
    expect(saved).toBe(true);
    expect(references.images.value).toEqual([image]);
    const post = apiRequest.mock.calls[1];
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ fileName: "plana.png", dataBase64: "cG5n", note: "女仆装" });

    const updated = await references.updateNote("plana", image.id, "泳装");
    expect(updated).toBe(true);
    expect(JSON.parse(String(apiRequest.mock.calls[2]?.[1]?.body))).toEqual({ note: "泳装" });
    expect(references.images.value).toEqual([editedImage]);
    expect(references.status.value).toEqual({ kind: "success", message: "备注已保存" });

    await references.remove("plana", image.id);
    expect(references.images.value).toEqual([]);
    expect(references.status.value).toEqual({ kind: "success", message: "参考图已删除" });
  });

  it("rejects files beyond the remaining slots before sending a request", async () => {
    const images = Array.from({ length: 8 }, (_, index) => ({ ...image, id: String(index).padStart(64, "0") }));
    apiRequest.mockResolvedValue({ images, maxImages: 9 });
    const references = useSelfieReferences();
    await references.load("plana");

    const saved = await references.upload("plana", [
      { file: new File(["1"], "one.png", { type: "image/png" }), note: "日常服" },
      { file: new File(["2"], "two.png", { type: "image/png" }), note: "泳装" }
    ]);

    expect(saved).toBe(false);
    expect(references.status.value).toEqual({ kind: "error", message: "还可添加 1 张" });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("clears the previous Agent and ignores its late GET response", async () => {
    const planaResponse = deferred<SelfieReferencePayload>();
    const aronaImage = { ...image, id: "b".repeat(64), note: "Arona 日常服" };
    const aronaResponse = deferred<SelfieReferencePayload>();
    apiRequest
      .mockReturnValueOnce(planaResponse.promise)
      .mockReturnValueOnce(aronaResponse.promise);
    const references = useSelfieReferences();

    const planaLoad = references.load("plana");
    const planaSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const aronaLoad = references.load("arona");

    expect(planaSignal.aborted).toBe(true);
    expect(references.images.value).toEqual([]);
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/selfie-references?agentId=plana",
      "/api/selfie-references?agentId=arona"
    ]);

    aronaResponse.resolve({ images: [aronaImage], maxImages: 9 });
    await expect(aronaLoad).resolves.toBe(true);
    planaResponse.resolve({ images: [image], maxImages: 9 });
    await expect(planaLoad).resolves.toBe(false);

    expect(references.images.value).toEqual([aronaImage]);
    expect(references.loading.value).toBe(false);
  });

  it("does not let a late mutation overwrite the newly selected Agent", async () => {
    const changedPlanaImage = { ...image, note: "已变更" };
    const aronaImage = { ...image, id: "c".repeat(64), note: "Arona 日常服" };
    const mutationResponse = deferred<SelfieReferencePayload>();
    apiRequest
      .mockResolvedValueOnce({ images: [image], maxImages: 9 })
      .mockReturnValueOnce(mutationResponse.promise)
      .mockResolvedValueOnce({ images: [aronaImage], maxImages: 9 });
    const references = useSelfieReferences();
    await references.load("plana");

    const mutation = references.updateNote("plana", image.id, "已变更");
    expect(apiRequest.mock.calls[1]?.[0]).toBe(`/api/selfie-references/${image.id}?agentId=plana`);
    const aronaLoad = references.load("arona");
    expect(references.images.value).toEqual([]);
    await expect(aronaLoad).resolves.toBe(true);

    mutationResponse.resolve({ images: [changedPlanaImage], maxImages: 9 });
    await expect(mutation).resolves.toBe(false);

    expect(references.images.value).toEqual([aronaImage]);
    expect(references.status.value).toEqual({ kind: "idle", message: "" });
    expect(references.updatingId.value).toBe("");
  });

  it("keeps a batch upload bound to its original Agent and stops after a switch", async () => {
    const firstUploadResponse = deferred<SelfieReferencePayload>();
    const aronaImage = { ...image, id: "d".repeat(64), note: "Arona 日常服" };
    apiRequest
      .mockResolvedValueOnce({ images: [], maxImages: 9 })
      .mockReturnValueOnce(firstUploadResponse.promise)
      .mockResolvedValueOnce({ images: [aronaImage], maxImages: 9 });
    const references = useSelfieReferences();
    await references.load("plana");

    const upload = references.upload("plana", [
      { file: new File(["one"], "one.png", { type: "image/png" }), note: "日常服" },
      { file: new File(["two"], "two.png", { type: "image/png" }), note: "泳装" }
    ]);
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/selfie-references?agentId=plana");

    await references.load("arona");
    firstUploadResponse.resolve({ images: [image], maxImages: 9 });
    await expect(upload).resolves.toBe(false);

    const postCalls = apiRequest.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.[0]).toBe("/api/selfie-references?agentId=plana");
    expect(references.images.value).toEqual([aronaImage]);
  });

  it.each([
    ["空备注", "   "],
    ["换行", "女仆装\n正面"],
    ["孤立代理项", String.fromCharCode(0xd800)],
    ["超长备注", "字".repeat(121)]
  ])("rejects %s before upload", async (_caseName, note) => {
    apiRequest.mockResolvedValue({ images: [], maxImages: 9 });
    const references = useSelfieReferences();
    await references.load("plana");

    const saved = await references.upload("plana", [{
      file: new File(["png"], "plana.png", { type: "image/png" }),
      note
    }]);

    expect(saved).toBe(false);
    expect(references.status.value.kind).toBe("error");
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["前置 Tab", "\t泳装"],
    ["后置 Tab", "泳装\t"],
    ["前置 CR", "\r泳装"],
    ["后置 CR", "泳装\r"],
    ["前置 LF", "\n泳装"],
    ["后置 LF", "泳装\n"]
  ])("rejects raw %s before upload or note update without an API request", async (_caseName, note) => {
    const references = useSelfieReferences();
    const file = new File(["png"], "plana.png", { type: "image/png" });

    await expect(references.upload("plana", [{ file, note }])).resolves.toBe(false);
    await expect(references.updateNote("plana", image.id, note)).resolves.toBe(false);

    expect(normalizeSelfieReferenceNote(note)).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("normalizes notes by Unicode code point count", () => {
    expect(normalizeSelfieReferenceNote(" e\u0301 ")).toBe("é");
    expect(normalizeSelfieReferenceNote("🩱".repeat(120))).toBe("🩱".repeat(120));
    expect(normalizeSelfieReferenceNote("🩱".repeat(121))).toBeNull();
  });
});
