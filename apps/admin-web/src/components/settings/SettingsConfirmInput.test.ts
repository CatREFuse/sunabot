import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";

describe("SettingsConfirmInput", () => {
  it("keeps typing local until the confirm button is pressed", async () => {
    const wrapper = mount(SettingsConfirmInput, { props: { modelValue: "原值", confirmLabel: "确认名称" } });

    await wrapper.get("input").setValue("新值");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.get('[data-confirm-label="确认名称"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('[data-confirm-label="确认名称"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["新值"]]);
    expect(wrapper.emitted("confirm")).toEqual([[]]);
  });

  it("applies trim and number modifiers when confirming with Enter", async () => {
    const wrapper = mount(SettingsConfirmInput, {
      props: { modelValue: 3, modelModifiers: { number: true, trim: true }, type: "number" }
    });

    await wrapper.get("input").setValue(" 8 ");
    await wrapper.get("input").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("update:modelValue")).toEqual([[8]]);
  });

  it("does not emit for unchanged, disabled, or readonly values", async () => {
    const unchanged = mount(SettingsConfirmInput, { props: { modelValue: "原值" } });
    expect(unchanged.get("button").attributes("disabled")).toBeDefined();
    await unchanged.get("button").trigger("click");
    expect(unchanged.emitted("update:modelValue")).toBeUndefined();

    const disabled = mount(SettingsConfirmInput, { props: { modelValue: "原值" }, attrs: { disabled: true } });
    await disabled.get("input").setValue("新值");
    await disabled.get("input").trigger("keydown", { key: "Enter" });
    expect(disabled.emitted("update:modelValue")).toBeUndefined();

    const readonly = mount(SettingsConfirmInput, { props: { modelValue: "原值" }, attrs: { readonly: true } });
    expect(readonly.find("button").exists()).toBe(false);
    await readonly.get("input").setValue("新值");
    expect(readonly.emitted("update:modelValue")).toBeUndefined();
  });
});
