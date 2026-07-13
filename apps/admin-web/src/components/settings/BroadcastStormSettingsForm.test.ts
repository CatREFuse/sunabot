import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BroadcastStormSettingsForm from "./BroadcastStormSettingsForm.vue";

describe("BroadcastStormSettingsForm", () => {
  it("shows the shared switch and m/n/k fields", () => {
    const wrapper = mount(BroadcastStormSettingsForm, {
      props: {
        modelValue: {
          enabled: true,
          windowMinutes: 2,
          replyThreshold: 3,
          cooldownMinutes: 1
        }
      }
    });

    expect(wrapper.text()).toContain("广播风暴嗅探");
    expect(wrapper.text()).toContain("检测窗口（分钟）");
    expect(wrapper.text()).toContain("回复次数");
    expect(wrapper.text()).toContain("静默时长（分钟）");
    expect(wrapper.findAll('input[type="number"]').map((input) => (
      (input.element as HTMLInputElement).value
    ))).toEqual(["2", "3", "1"]);
  });

  it("disables the numeric fields when sniffing is off", () => {
    const wrapper = mount(BroadcastStormSettingsForm, {
      props: {
        modelValue: {
          enabled: false,
          windowMinutes: 2,
          replyThreshold: 3,
          cooldownMinutes: 1
        }
      }
    });

    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined();
  });
});
