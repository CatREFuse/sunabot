import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageHistoryRecord } from "../types";

const apiMocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  apiBlob: vi.fn(),
  authenticatedMediaPath: vi.fn((source: string) => source.startsWith("http")
    ? `/api/media/image?url=${encodeURIComponent(source)}`
    : source)
}));

vi.mock("./useAdminApi", () => apiMocks);

beforeEach(() => {
  vi.resetModules();
  apiMocks.apiRequest.mockReset();
  apiMocks.apiBlob.mockReset();
  apiMocks.authenticatedMediaPath.mockClear();
  window.localStorage.clear();
});

describe("useImageStudio", () => {
  it("scopes history requests and the short-lived cache by Agent", async () => {
    apiMocks.apiRequest.mockImplementation(async (path: string) => ({
      images: [image(path.includes("agent-a") ? "a" : "b")]
    }));
    const { useImageStudio } = await import("./useImageStudio");
    const state = useImageStudio();

    await expect(state.load("agent-a")).resolves.toBe(true);
    expect(state.images.value.map(({ id }) => id)).toEqual(["a"]);
    const agentBLoad = state.load("agent-b");
    expect(state.images.value).toEqual([]);
    await expect(agentBLoad).resolves.toBe(true);
    expect(state.images.value.map(({ id }) => id)).toEqual(["b"]);
    await expect(state.load("agent-a")).resolves.toBe(true);

    expect(state.images.value.map(({ id }) => id)).toEqual(["a"]);
    expect(apiMocks.apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/images?agentId=agent-a",
      "/api/images?agentId=agent-b"
    ]);
  });

  it("does not let an old Agent response overwrite the current Agent", async () => {
    const delayedAgentA = deferred<{ images: ImageHistoryRecord[] }>();
    apiMocks.apiRequest.mockImplementation((path: string) => path.includes("agent-a")
      ? delayedAgentA.promise
      : Promise.resolve({ images: [image("b")] }));
    const { useImageStudio } = await import("./useImageStudio");
    const state = useImageStudio();

    const oldLoad = state.load("agent-a");
    await expect(state.load("agent-b")).resolves.toBe(true);
    delayedAgentA.resolve({ images: [image("a")] });
    await expect(oldLoad).resolves.toBe(false);

    expect(state.images.value.map(({ id }) => id)).toEqual(["b"]);
    expect(state.loading.value).toBe(false);
    expect(state.error.value).toBe("");
  });

  it("cancels stale downloads and keeps their state out of the next Agent", async () => {
    apiMocks.apiRequest.mockResolvedValue({ images: [] });
    const delayedBlob = deferred<Blob>();
    apiMocks.apiBlob.mockReturnValue(delayedBlob.promise);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const { useImageStudio } = await import("./useImageStudio");
    const state = useImageStudio();
    await state.load("agent-a");

    const oldDownload = state.download("agent-a", image("a", "https://example.com/a.png"));
    expect(state.downloadingId.value).toBe("a");
    await state.load("agent-b");
    expect(state.downloadingId.value).toBe("");
    delayedBlob.resolve(new Blob(["image"], { type: "image/png" }));

    await expect(oldDownload).resolves.toBe(false);
    expect(state.downloadingId.value).toBe("");
    expect(state.error.value).toBe("");
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(apiMocks.apiBlob.mock.calls[0]?.[0]).toContain("agentId=agent-a");
    expect(apiMocks.apiBlob.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    createObjectUrl.mockRestore();
  });
});

describe("imageDownloadName", () => {
  it("uses and sanitizes a stored filename", async () => {
    const { imageDownloadName } = await import("./useImageStudio");
    expect(imageDownloadName({ id: "1", url: "/generated-images/a.png", filePath: "/tmp/危险 image.png", createdAt: "" }, "image/png"))
      .toBe("image.png");
  });

  it("adds a MIME extension to a stable fallback name", async () => {
    const { imageDownloadName } = await import("./useImageStudio");
    expect(imageDownloadName({ id: "history 7", url: "", createdAt: "" }, "image/webp"))
      .toBe("sunabot-image-history-7.webp");
  });
});

function image(id: string, url = `/generated-images/${id}.png`): ImageHistoryRecord {
  return { id, url, createdAt: "2026-07-18T00:00:00.000Z" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
