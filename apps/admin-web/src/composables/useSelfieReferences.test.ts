import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelfieReferenceImage, SelfieReferencePayload } from "../types";
import { useSelfieReferences } from "./useSelfieReferences";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

const image: SelfieReferenceImage = {
  id: "01-neutral-face.png",
  fileName: "01-neutral-face.png",
  sizeBytes: 240_000,
  width: 458,
  height: 501,
  updatedAt: "2026-07-12T10:00:00.000Z",
  originalUrl: "/api/selfie-references/01-neutral-face.png/content?variant=original",
  displayUrl: "/api/selfie-references/01-neutral-face.png/content?variant=display",
  placeholderUrl: "/api/selfie-references/01-neutral-face.png/content?variant=placeholder"
};

describe("useSelfieReferences", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads, uploads, and removes reference images", async () => {
    const empty: SelfieReferencePayload = { images: [], maxImages: 3 };
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/selfie-references" && !init?.method) return Promise.resolve(empty);
      if (path === "/api/selfie-references" && init?.method === "POST") return Promise.resolve({ images: [image], maxImages: 3 });
      if (path?.endsWith("/01-neutral-face.png") && init?.method === "DELETE") return Promise.resolve(undefined);
      throw new Error(`Unexpected request: ${path}`);
    });
    const references = useSelfieReferences();

    await references.load();
    const saved = await references.upload([new File(["png"], "plana.png", { type: "image/png" })]);
    expect(saved).toBe(true);
    expect(references.images.value).toEqual([image]);
    const post = apiRequest.mock.calls[1];
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ fileName: "plana.png", dataBase64: "cG5n" });

    await references.remove(image.id);
    expect(references.images.value).toEqual([]);
    expect(references.status.value).toEqual({ kind: "success", message: "参考图已删除" });
  });

  it("rejects files beyond the remaining slots before sending a request", async () => {
    apiRequest.mockResolvedValue({ images: [image, { ...image, id: "2" }], maxImages: 3 });
    const references = useSelfieReferences();
    await references.load();

    const saved = await references.upload([
      new File(["1"], "one.png", { type: "image/png" }),
      new File(["2"], "two.png", { type: "image/png" })
    ]);

    expect(saved).toBe(false);
    expect(references.status.value).toEqual({ kind: "error", message: "还可添加 1 张" });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});
