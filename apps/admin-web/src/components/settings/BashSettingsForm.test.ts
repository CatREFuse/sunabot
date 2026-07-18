import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConfigSectionValueMap } from "../../types";
import BashSettingsForm from "./BashSettingsForm.vue";

function bashDraft(): ConfigSectionValueMap["bash"] {
  return {
    enabled: true,
    adminPrivateBackend: "native",
    auditModel: "gpt-5.4-mini",
    strictMode: true,
    allowGroup: false,
    adminOnly: true,
    workspaceOnly: true,
    blockedKeywords: ["rm"]
  };
}

describe("BashSettingsForm", () => {
  it("selects the administrator backend and describes the enforced conversation scope", async () => {
    const draft = bashDraft();
    const wrapper = mount(BashSettingsForm, { props: { modelValue: draft } });

    await wrapper.get("select").setValue("docker");

    expect(draft.adminPrivateBackend).toBe("docker");
    expect(wrapper.text()).toContain("允许管理员在群聊中使用");
    expect(wrapper.text()).toContain("群聊固定使用 Docker 受限模式");
    expect(wrapper.text()).toContain("Web Chat");
    expect(wrapper.text()).toContain("不可用");
  });

  it("does not present deprecated keyword and workspace flags as active isolation controls", () => {
    const wrapper = mount(BashSettingsForm, { props: { modelValue: bashDraft() } });

    expect(wrapper.text()).not.toContain("阻止关键字");
    expect(wrapper.text()).not.toContain("仅 Agent Workspace");
    expect(wrapper.text()).toContain("Agent workbench");
    expect(wrapper.text()).toContain("只读逐次确认");
  });

  it("writes the audit and session controls back to the Bash draft", async () => {
    const draft = bashDraft();
    const wrapper = mount(BashSettingsForm, { props: { modelValue: draft } });
    const [strictMode, adminOnly, allowGroup] = wrapper.findAll('input[type="checkbox"]');

    await wrapper.get('input[type="text"]').setValue("gpt-5.5-audit");
    await strictMode!.setValue(false);
    await adminOnly!.setValue(false);
    await allowGroup!.setValue(true);

    expect(draft).toMatchObject({
      auditModel: "gpt-5.5-audit",
      strictMode: false,
      adminOnly: false,
      allowGroup: true
    });
    expect(wrapper.text()).toContain("关闭将停用 Bash");
  });
});
