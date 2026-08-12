import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import QuasarSegmented from "./QuasarSegmented.vue";

const options = [
  { label: "亮色", value: "light" },
  { label: "暗色", value: "dark" },
  { label: "跟随系统", value: "system" }
] as const;

describe("QuasarSegmented", () => {
  it("exposes a semantic selected state and emits the chosen value", async () => {
    const wrapper = mount(QuasarSegmented, {
      props: {
        modelValue: "light",
        label: "切换外观",
        options,
        "onUpdate:modelValue": (value: string) => wrapper.setProps({ modelValue: value })
      }
    });

    expect(wrapper.get('[role="group"]').attributes("aria-label")).toBe("切换外观");
    expect(wrapper.findAll("button").map((button) => button.attributes("aria-pressed"))).toEqual([
      "true",
      "false",
      "false"
    ]);

    await wrapper.findAll("button")[1].trigger("click");

    expect(wrapper.emitted("update:modelValue")).toEqual([["dark"]]);
    expect(wrapper.findAll("button")[1].attributes("aria-pressed")).toBe("true");
  });

  it("blocks every option when the group is disabled", async () => {
    const wrapper = mount(QuasarSegmented, {
      props: {
        modelValue: "system",
        label: "切换外观",
        options,
        disabled: true
      }
    });

    expect(wrapper.get('[role="group"]').attributes("aria-disabled")).toBe("true");
    expect(wrapper.findAll("button").every((button) => "disabled" in button.attributes())).toBe(true);
    await wrapper.findAll("button")[0].trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});
