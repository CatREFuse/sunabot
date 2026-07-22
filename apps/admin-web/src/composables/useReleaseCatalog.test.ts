import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReleaseCatalog } from "./useReleaseCatalog";

const apiRequestUnscoped = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useAdminApi")>();
  return { ...original, apiRequestUnscoped };
});

let wrapper: ReturnType<typeof mount> | undefined;

beforeEach(() => apiRequestUnscoped.mockReset());
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("useReleaseCatalog", () => {
  it("loads the current version and changelog", async () => {
    apiRequestUnscoped.mockResolvedValueOnce(releaseCatalog());
    const releases = mountReleases();

    await expect(releases.load()).resolves.toBe(true);

    expect(apiRequestUnscoped).toHaveBeenCalledWith("/api/releases");
    expect(releases.catalog.value?.currentVersion).toBe("0.1.0");
    expect(releases.catalog.value?.releases[0]?.groups).toHaveLength(1);
    expect(releases.error.value).toBe("");
  });

  it("rejects a catalog whose current version has no release entry", async () => {
    apiRequestUnscoped.mockResolvedValueOnce({ ...releaseCatalog(), currentVersion: "0.2.0" });
    const releases = mountReleases();

    await expect(releases.load()).resolves.toBe(false);

    expect(releases.catalog.value).toBeNull();
    expect(releases.error.value).toBe("版本信息格式无效。");
  });

  it("keeps the last valid catalog when refresh fails", async () => {
    apiRequestUnscoped
      .mockResolvedValueOnce(releaseCatalog())
      .mockRejectedValueOnce(new Error("服务暂不可用。"));
    const releases = mountReleases();
    await releases.load();

    await expect(releases.load()).resolves.toBe(false);

    expect(releases.catalog.value?.currentVersion).toBe("0.1.0");
    expect(releases.error.value).toBe("服务暂不可用。");
  });
});

function mountReleases() {
  let releases!: ReturnType<typeof useReleaseCatalog>;
  const Harness = defineComponent({
    setup() {
      releases = useReleaseCatalog();
      return () => h("div");
    }
  });
  wrapper = mount(Harness);
  return releases;
}

function releaseCatalog() {
  return {
    schemaVersion: 1,
    currentVersion: "0.1.0",
    releases: [{
      version: "0.1.0",
      releasedAt: "2026-07-22",
      title: "首次发布",
      summary: "首个可用版本。",
      groups: [{ title: "核心能力", items: ["支持多 Agent。"] }]
    }]
  };
}
