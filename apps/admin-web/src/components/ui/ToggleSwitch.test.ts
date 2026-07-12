import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToggleSwitch from "./ToggleSwitch.vue";

describe("ToggleSwitch", () => {
  it("moves the thumb and uses the monochrome display color when enabled", async () => {
    const wrapper = mount(ToggleSwitch, {
      props: {
        label: "启用",
        modelValue: false,
        "onUpdate:modelValue": (value: boolean) => wrapper.setProps({ modelValue: value })
      }
    });

    await wrapper.get("input").setValue(true);

    expect(wrapper.get('[data-slot="toggle-track"]').classes()).toContain("bg-display");
    expect(wrapper.get('[data-slot="toggle-thumb"]').classes()).toContain("translate-x-5");
  });
});
