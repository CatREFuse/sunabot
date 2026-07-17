import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import McpServerDialog from "./McpServerDialog.vue";

const DialogOverlay = {
  props: ["open"],
  template: '<div v-if="open"><slot /></div>'
};

describe("McpServerDialog", () => {
  it("keeps an empty allowlist deny-all and labels the policy faithfully", async () => {
    const wrapper = mount(McpServerDialog, {
      props: { open: true, server: null, preview: null, busy: false, error: "" },
      global: { stubs: { DialogOverlay } }
    });

    const allowlist = wrapper.get<HTMLTextAreaElement>('textarea[placeholder="每行一个，留空则关闭所有工具"]');
    expect(allowlist.element.value).toBe("");
    expect(wrapper.text()).not.toContain("允许全部");

    await wrapper.get('input[placeholder="/usr/bin/server"]').setValue("/usr/bin/example-mcp");
    await wrapper.get("form").trigger("submit");

    const server = wrapper.emitted("preview")?.[0]?.[0] as { enabledTools?: string[] };
    expect(server.enabledTools).toEqual([]);
  });
});
