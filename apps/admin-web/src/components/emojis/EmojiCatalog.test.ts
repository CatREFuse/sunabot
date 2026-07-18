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
    const sendSizeButton = wrapper.findAll("button").find((button) => button.text() === "256");
    await sendSizeButton?.trigger("click");
    expect(dependencies.data?.setSendSize).toHaveBeenCalledWith("koharu", 256);
    const generateButton = wrapper.get('button[aria-label="一键添加 开心"]');
    await generateButton.trigger("click");
    expect(dependencies.data?.generate).toHaveBeenCalledWith("koharu", "开心");

    await wrapper.setProps({ agentId: "plana" });
    await flushPromises();
    expect(dependencies.data?.load).toHaveBeenLastCalledWith("plana");
    wrapper.unmount();
    expect(dependencies.data?.dispose).toHaveBeenCalledOnce();
  });

  it("uploads on card drop, renames a key, and opens version history", async () => {
    const wrapper = mount(EmojiCatalog, {
      props: { agentId: "koharu" },
      attachTo: document.body
    });
    await flushPromises();

    const file = new File(["png"], "happy.png", { type: "image/png" });
    await wrapper.findAll("article")[0]!.trigger("drop", {
      dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" }
    });
    expect(dependencies.data?.upload).toHaveBeenCalledWith("koharu", { key: "开心", file });

    await wrapper.get('button[aria-label="修改 自定义 key"]').trigger("click");
    const keyInput = wrapper.get('input[aria-label="修改 自定义 key"]');
    await keyInput.setValue("新表情");
    await keyInput.trigger("keyup.enter");
    expect(dependencies.data?.rename).toHaveBeenCalledWith("koharu", "自定义", "新表情");

    await wrapper.get('button[aria-label="查看 自定义 版本"]').trigger("click");
    expect(dependencies.data?.loadVersions).toHaveBeenCalledWith("koharu", "自定义");
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
    sendSize: shallowRef(512 as const),
    loading: shallowRef(false),
    savingSettings: shallowRef(false),
    uploading: shallowRef(false),
    uploadingKey: shallowRef(""),
    deletingKey: shallowRef(""),
    versionKey: shallowRef(""),
    versions: shallowRef([]),
    loadingVersions: shallowRef(false),
    deletingVersion: shallowRef(""),
    generatingKeys: shallowRef<ReadonlySet<string>>(new Set()),
    status: shallowRef({ kind: "idle" as const, message: "" }),
    load: vi.fn().mockResolvedValue(true),
    upload: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(true),
    loadVersions: vi.fn().mockResolvedValue(true),
    removeVersion: vi.fn().mockResolvedValue(true),
    clearVersions: vi.fn(),
    setSendSize: vi.fn().mockResolvedValue(true),
    clearStatus: vi.fn(),
    dispose: vi.fn()
  };
}
