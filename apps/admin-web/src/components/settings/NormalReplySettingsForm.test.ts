import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import NormalReplySettingsForm from "./NormalReplySettingsForm.vue";

describe("NormalReplySettingsForm", () => {
  it("shows and edits the normal reply retry limit", async () => {
    const modelValue = { maxRetries: 3 };
    const wrapper = mount(NormalReplySettingsForm, {
      props: { modelValue }
    });

    const input = wrapper.get('input[type="number"]');
    expect(input.element).toHaveProperty("value", "3");

    await input.setValue("6");

    expect(modelValue.maxRetries).toBe(6);
  });
});
