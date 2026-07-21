import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import KnowledgeUploadDialog from "./KnowledgeUploadDialog.vue";

function mountDialog() {
  return mount(KnowledgeUploadDialog, {
    props: { open: true, busy: false, error: "" },
    global: { stubs: { DialogOverlay: { template: "<div><slot /></div>" } } }
  });
}

async function selectFile(wrapper: ReturnType<typeof mountDialog>, file: { name: string; size: number; text(): Promise<string> }) {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
  await input.trigger("change");
}

describe("KnowledgeUploadDialog", () => {
  it("rejects Markdown files over 8 MiB before reading them", async () => {
    const wrapper = mountDialog();
    const text = vi.fn(async () => "正文");

    await selectFile(wrapper, { name: "过大.md", size: 8 * 1024 * 1024 + 1, text });

    expect(wrapper.text()).toContain("文件不能超过 8 MiB");
    expect(text).not.toHaveBeenCalled();
    expect(wrapper.emitted("upload")).toBeUndefined();
  });

  it("requires a Markdown extension for the nested save path", async () => {
    const wrapper = mountDialog();
    await selectFile(wrapper, { name: "手册.md", size: 12, text: async () => "# 手册" });
    await wrapper.get('input[type="text"]').setValue("运维/手册.txt");
    await wrapper.findAll("button").find((button) => button.text().includes("添加"))!.trigger("click");

    expect(wrapper.text()).toContain("保存位置需要使用 .md 或 .markdown");
    expect(wrapper.emitted("upload")).toBeUndefined();
  });
});
