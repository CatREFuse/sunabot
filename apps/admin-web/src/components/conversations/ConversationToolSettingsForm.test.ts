// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationToolSettingsForm from "./ConversationToolSettingsForm.vue";

describe("ConversationToolSettingsForm", () => {
  it("locks the Agent master switch and keeps capability state separate", async () => {
    const wrapper = mount(ConversationToolSettingsForm, {
      props: {
        tools: [
          { name: "websearch", title: "网页搜索", description: "搜索", enabled: false, available: true },
          {
            name: "read_file",
            title: "读取文件",
            description: "读取",
            enabled: true,
            available: false,
            unavailabilityKind: "session",
            accessLabel: "管理员 QQ 私聊可用",
            availabilityReason: "当前会话不允许读取 Agent workbench 文件。"
          },
          {
            name: "workspace_bash",
            title: "Bash",
            description: "运行命令",
            enabled: true,
            available: true,
            accessLabel: "管理员 QQ 私聊可用"
          }
        ],
        disabledTools: [],
        loading: false,
        busy: false
      },
      global: { stubs: { RouterLink: { template: "<a><slot /></a>" } } }
    });
    const toggles = wrapper.findAllComponents(ToggleSwitch);

    expect(toggles[0]!.props()).toMatchObject({ label: "启用 网页搜索", disabled: true, modelValue: false });
    expect(toggles[1]!.props()).toMatchObject({ label: "启用 读取文件", disabled: false, modelValue: true });
    expect(toggles[2]!.props()).toMatchObject({ label: "启用 Bash", disabled: false, modelValue: true });
    expect(wrapper.text()).toContain("Agent 已停用");
    expect(wrapper.text()).toContain("管理员 QQ 私聊可用");
    expect(wrapper.text()).not.toContain("当前会话不允许读取 Agent workbench 文件。");
    expect(wrapper.text()).not.toContain("能力可用");
    expect(wrapper.text()).not.toContain("能力不可用");

    await toggles[1]!.vm.$emit("update:modelValue", false);
    expect(wrapper.emitted("toggle")).toEqual([["read_file", false]]);
  });

  it("shows an anomaly fallback only when the runtime reports a failure", () => {
    const wrapper = mount(ConversationToolSettingsForm, {
      props: {
        tools: [{
          name: "run_skill_script",
          title: "运行 Skill 脚本",
          description: "运行当前会话已启用 Skill 的脚本。",
          enabled: true,
          available: false
        }],
        disabledTools: [],
        loading: false,
        busy: false
      },
      global: { stubs: { RouterLink: { template: "<a><slot /></a>" } } }
    });

    expect(wrapper.text()).toContain("当前工具运行异常。");
    expect(wrapper.text()).not.toContain("能力可用");
    expect(wrapper.text()).not.toContain("能力不可用");
  });
});
