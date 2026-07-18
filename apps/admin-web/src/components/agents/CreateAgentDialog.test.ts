import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentConfigImportPicker from "./AgentConfigImportPicker.vue";
import CreateAgentDialog from "./CreateAgentDialog.vue";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CreateAgentDialog", () => {
  it("remounts the import picker with empty state after the dialog reopens", async () => {
    const host = document.createElement("div");
    host.id = "app";
    document.body.append(host);
    const wrapper = mount(CreateAgentDialog, {
      attachTo: host,
      props: { open: true }
    });
    const firstPicker = wrapper.getComponent(AgentConfigImportPicker);
    apiRequest.mockResolvedValue({ source: "folder", included: ["AGENTS.md"], missing: ["头像"] });
    const file = new File(["你是阿罗娜。"], "AGENTS.md", { type: "text/markdown" });
    const input = firstPicker.findAll('input[type="file"]')[0];
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await flushPromises();
    expect(firstPicker.text()).toContain("已校验 1 个文件");

    await wrapper.setProps({ open: false });
    await nextTick();
    expect(wrapper.findComponent(AgentConfigImportPicker).exists()).toBe(false);

    await wrapper.setProps({ open: true });
    await nextTick();
    const reopenedPicker = wrapper.getComponent(AgentConfigImportPicker);
    expect(reopenedPicker.text()).not.toContain("已校验");
    expect(reopenedPicker.text()).not.toContain("配置包校验失败");
  });
});
