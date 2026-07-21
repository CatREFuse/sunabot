import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import KnowledgeBrowser from "./KnowledgeBrowser.vue";

describe("KnowledgeBrowser", () => {
  it("groups nested documents and emits the selected document for deletion", async () => {
    const documents = [
      { path: "手册/接入.md", format: "markdown" as const, sizeBytes: 1024, chunkCount: 3, status: "indexed" as const, updatedAt: "now" },
      { path: "记录.jsonl", format: "jsonl" as const, sizeBytes: 80, chunkCount: 2, status: "indexed" as const, updatedAt: "now" }
    ];
    const wrapper = mount(KnowledgeBrowser, {
      props: { documents, loading: false, busy: false, pendingDelete: "" }
    });

    expect(wrapper.text()).toContain("手册");
    expect(wrapper.text()).toContain("根目录");
    expect(wrapper.text()).toContain("接入.md");
    await wrapper.get('button[aria-label="删除 手册/接入.md"]').trigger("click");
    expect(wrapper.emitted("remove")).toEqual([[documents[0]]]);
  });
});
