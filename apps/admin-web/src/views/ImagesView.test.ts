import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImagesView from "./ImagesView.vue";
import { activeAgentIdState } from "../composables/agentScope";

const studioMocks = vi.hoisted(() => ({
  load: vi.fn(async () => true),
  download: vi.fn(async () => true),
  cancelLoad: vi.fn(),
  dispose: vi.fn()
}));

vi.mock("../composables/agentScope", async () => {
  const { shallowRef } = await vi.importActual<typeof import("vue")>("vue");
  return { activeAgentIdState: shallowRef("plana") };
});

vi.mock("../composables/useImageStudio", async () => {
  const { shallowRef } = await vi.importActual<typeof import("vue")>("vue");
  return {
    useImageStudio: () => ({
      images: shallowRef([]),
      loading: shallowRef(false),
      downloadingId: shallowRef(""),
      error: shallowRef(""),
      ...studioMocks
    })
  };
});

beforeEach(() => {
  studioMocks.load.mockClear();
  studioMocks.download.mockClear();
  studioMocks.cancelLoad.mockClear();
  studioMocks.dispose.mockClear();
  (activeAgentIdState as { value: string }).value = "plana";
});

describe("ImagesView", () => {
  it("loads immediately and cleans up the old request when Agent changes", async () => {
    const wrapper = shallowMount(ImagesView);
    expect(studioMocks.load).toHaveBeenCalledWith("plana");

    (activeAgentIdState as { value: string }).value = "arona";
    await nextTick();

    expect(studioMocks.cancelLoad).toHaveBeenCalledWith("plana");
    expect(studioMocks.load).toHaveBeenLastCalledWith("arona");
    wrapper.unmount();
    expect(studioMocks.cancelLoad).toHaveBeenLastCalledWith("arona");
    expect(studioMocks.dispose).toHaveBeenCalledOnce();
  });
});
