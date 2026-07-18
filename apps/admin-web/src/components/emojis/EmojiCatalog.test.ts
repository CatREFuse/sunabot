import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmojiRecord } from "../../types/emojis";

const dependencies = vi.hoisted(() => ({ data: null as ReturnType<typeof createData> | null }));
vi.mock("../../composables/useEmojis", () => ({ useEmojis: () => dependencies.data }));

import EmojiCatalog from "./EmojiCatalog.vue";

describe("EmojiCatalog", () => {
  beforeEach(() => { dependencies.data = createData(); });
  afterEach(() => { document.body.innerHTML = ""; });

  it("loads on Agent changes and runs one-click generation for a preset", async () => {
    const wrapper = mount(EmojiCatalog, {
      props: { agentId: "koharu" },
      attachTo: document.body
    });
    await flushPromises();

    expect(dependencies.data?.load).toHaveBeenCalledWith("koharu");
    const generateButton = wrapper.findAll("button").find((button) => button.text().includes("一键添加"));
    await generateButton?.trigger("click");
    expect(dependencies.data?.generate).toHaveBeenCalledWith("koharu", "开心");

    await wrapper.setProps({ agentId: "plana" });
    await flushPromises();
    expect(dependencies.data?.load).toHaveBeenLastCalledWith("plana");
    wrapper.unmount();
    expect(dependencies.data?.dispose).toHaveBeenCalledOnce();
  });

  it("reloads the image when replacing the same key with a new content version", async () => {
    const data = dependencies.data!;
    const current = data.emojis.value[0]!;
    data.presetKeys.value = [current.key];
    data.emojis.value = [{
      ...current,
      displayUrl: "/api/emojis/custom/content?variant=display&v=emoji-old.png",
      placeholderUrl: "/api/emojis/custom/content?variant=placeholder&v=emoji-old.png"
    }];
    const wrapper = mount(EmojiCatalog, {
      props: { agentId: "koharu" },
      attachTo: document.body
    });
    await flushPromises();
    expect(wrapper.get(".authenticated-image__main").attributes("src")).toContain("v=emoji-old.png");

    data.emojis.value = [{
      ...data.emojis.value[0]!,
      fileName: "emoji-new.png",
      updatedAt: "2026-07-18T11:00:00.000Z",
      displayUrl: "/api/emojis/custom/content?variant=display&v=emoji-new.png",
      placeholderUrl: "/api/emojis/custom/content?variant=placeholder&v=emoji-new.png"
    }];
    await nextTick();

    expect(wrapper.get(".authenticated-image__main").attributes("src")).toContain("v=emoji-new.png");
    wrapper.unmount();
  });
});

function createData() {
  const emoji: EmojiRecord = {
    key: "自定义",
    source: "upload",
    fileName: "custom.png",
    sizeBytes: 100_000,
    width: 1024,
    height: 1024,
    updatedAt: "2026-07-18T10:00:00.000Z",
    originalUrl: "/api/emojis/custom/content?variant=original",
    displayUrl: "/api/emojis/custom/content?variant=display",
    placeholderUrl: "/api/emojis/custom/content?variant=placeholder"
  };
  return {
    emojis: shallowRef<EmojiRecord[]>([emoji]),
    presetKeys: shallowRef(["开心"]),
    loading: shallowRef(false),
    uploading: shallowRef(false),
    deletingKey: shallowRef(""),
    generatingKeys: shallowRef<ReadonlySet<string>>(new Set()),
    status: shallowRef({ kind: "idle" as const, message: "" }),
    load: vi.fn().mockResolvedValue(true),
    upload: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    clearStatus: vi.fn(),
    dispose: vi.fn()
  };
}
