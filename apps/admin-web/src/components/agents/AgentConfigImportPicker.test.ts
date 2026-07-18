import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentConfigImportPicker from "./AgentConfigImportPicker.vue";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockReset();
});

describe("AgentConfigImportPicker", () => {
  it("uses webkitRelativePath and displays missing defaults after folder validation", async () => {
    apiRequest.mockResolvedValue({
      source: "folder",
      included: ["AGENTS.md"],
      missing: ["Agent 配置", "头像"]
    });
    const wrapper = mount(AgentConfigImportPicker);
    const file = new File(["你是阿罗娜。"], "AGENTS.md", { type: "text/markdown" });
    Object.defineProperty(file, "webkitRelativePath", { value: "arona/AGENTS.md" });
    const folderInput = wrapper.findAll('input[type="file"]')[0];
    Object.defineProperty(folderInput.element, "files", { configurable: true, value: [file] });

    await folderInput.trigger("change");
    await flushPromises();

    const [, options] = apiRequest.mock.calls[0];
    expect(apiRequest).toHaveBeenCalledWith("/api/agent-imports/preview", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(options.body)).toMatchObject({
      source: "folder",
      files: [{ path: "arona/AGENTS.md" }]
    });
    expect(wrapper.text()).toContain("已校验 1 个文件");
    expect(wrapper.text()).toContain("Agent 配置、头像");
    expect(wrapper.emitted("change")?.[0]?.[0]).toMatchObject({ source: "folder" });
  });

  it("builds a ZIP payload and clears it when validation fails", async () => {
    apiRequest
      .mockResolvedValueOnce({ source: "zip", included: ["AGENTS.md"], missing: [] })
      .mockRejectedValueOnce(new Error("ZIP 配置包无效。"));
    const wrapper = mount(AgentConfigImportPicker);
    const zipInput = wrapper.findAll('input[type="file"]')[1];

    Object.defineProperty(zipInput.element, "files", {
      configurable: true,
      value: [new File(["valid"], "agent.zip", { type: "application/zip" })]
    });
    await zipInput.trigger("change");
    await flushPromises();
    const firstPayload = JSON.parse(apiRequest.mock.calls[0][1].body);
    expect(firstPayload).toMatchObject({ source: "zip", fileName: "agent.zip" });
    expect(firstPayload.dataBase64).toBe(btoa("valid"));

    Object.defineProperty(zipInput.element, "files", {
      configurable: true,
      value: [new File(["invalid"], "broken.zip", { type: "application/zip" })]
    });
    await zipInput.trigger("change");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe("ZIP 配置包无效。");
    expect(wrapper.emitted("change")?.at(-1)).toEqual([undefined]);
  });

  it("disables both import inputs while the dialog is busy", () => {
    const wrapper = mount(AgentConfigImportPicker, { props: { disabled: true } });
    expect(wrapper.findAll('input[type="file"]')).toHaveLength(2);
    for (const input of wrapper.findAll('input[type="file"]')) {
      expect(input.attributes("disabled")).toBeDefined();
    }
  });
});
