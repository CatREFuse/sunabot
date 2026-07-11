import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DialogOverlay from "./DialogOverlay.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DialogOverlay", () => {
  it("traps keyboard focus, closes with Escape and restores focus", async () => {
    const app = document.createElement("div");
    app.id = "app";
    const trigger = document.createElement("button");
    trigger.textContent = "打开";
    app.append(trigger);
    document.body.append(app);
    trigger.focus();

    const wrapper = mount(DialogOverlay, {
      props: { open: true, labelledby: "dialog-title" },
      slots: {
        default: '<section><h2 id="dialog-title">标题</h2><button id="first">第一个</button><button id="last">最后一个</button></section>'
      },
      attachTo: document.body
    });
    await nextTick();

    expect(app.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.id).toBe("first");
    const last = document.querySelector<HTMLButtonElement>("#last")!;
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement?.id).toBe("first");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.setProps({ open: false });
    await nextTick();
    expect(app.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    wrapper.unmount();
  });

  it("only dismisses from the backdrop when allowed", async () => {
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
    const wrapper = mount(DialogOverlay, {
      props: { open: true, dismissible: false, ariaLabel: "锁定弹层" },
      slots: { default: "<section>内容</section>" },
      attachTo: document.body
    });
    await nextTick();

    await document.querySelector<HTMLElement>(".dialog-overlay")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });
});
