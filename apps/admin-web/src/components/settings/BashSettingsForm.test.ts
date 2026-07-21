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
  it("shows the fixed Native administrator and Docker ordinary-user routing", () => {
    const draft = bashDraft();
    const wrapper = mount(BashSettingsForm, { props: { modelValue: draft } });

    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.text()).toContain("管理员 QQ 私聊Native Bash");
    expect(wrapper.text()).toContain("全部群聊与其他 QQ 私聊Docker Bash");
    expect(wrapper.text()).toContain("Web Chat");
    expect(wrapper.text()).toContain("不可用");
  });

  it("does not present deprecated keyword and workspace flags as active isolation controls", () => {
    const wrapper = mount(BashSettingsForm, { props: { modelValue: bashDraft() } });

    expect(wrapper.text()).not.toContain("阻止关键字");
    expect(wrapper.text()).not.toContain("仅 Agent Workspace");
    expect(wrapper.text()).toContain("Skill 与 MCP · Docker 只读");
    expect(wrapper.text()).toContain("Native 与 Docker 分离");
  });

  it("writes only the approval model and strict approval control back to the Bash draft", async () => {
    const draft = bashDraft();
    const wrapper = mount(BashSettingsForm, { props: { modelValue: draft } });
    const [strictMode] = wrapper.findAll('input[type="checkbox"]');

    await wrapper.get('input[type="text"]').setValue("gpt-5.5-audit");
    expect(draft.auditModel).toBe("gpt-5.4-mini");
    await wrapper.get('[data-confirm-label="确认审批模型"]').trigger("click");
    await strictMode!.setValue(false);

    expect(draft).toMatchObject({
      auditModel: "gpt-5.5-audit",
      strictMode: false,
      adminOnly: true,
      allowGroup: false
    });
    expect(wrapper.text()).toContain("对抗审批 Agent");
    expect(wrapper.text()).toContain("每条 Native 与 Docker Bash 命令");
  });
});
