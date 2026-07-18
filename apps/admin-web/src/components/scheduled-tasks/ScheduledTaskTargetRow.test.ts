import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ScheduledTaskTargetRow from "./ScheduledTaskTargetRow.vue";

describe("ScheduledTaskTargetRow", () => {
  it("adds and removes multiple QQ mentions for a group target", async () => {
    const wrapper = mount(ScheduledTaskTargetRow, {
      props: {
        target: { conversationId: "group:10001", mentionUserIds: ["7"] },
        conversations: [],
        removable: true
      }
    });

    await wrapper.get('input[placeholder="输入 QQ 号"]').setValue("8");
    await wrapper.get("button.btn").trigger("click");
    expect(wrapper.emitted("update")?.at(-1)?.[0]).toEqual({
      conversationId: "group:10001",
      mentionUserIds: ["7", "8"]
    });

    await wrapper.get('button[aria-label="移除 @7"]').trigger("click");
    expect(wrapper.emitted("update")?.at(-1)?.[0]).toEqual({
      conversationId: "group:10001",
      mentionUserIds: []
    });
  });

  it("clears mentions when the callback changes to a private conversation", async () => {
    const wrapper = mount(ScheduledTaskTargetRow, {
      props: {
        target: { conversationId: "group:10001", mentionUserIds: ["7", "8"] },
        conversations: [],
        removable: true
      }
    });

    await wrapper.get('input[placeholder="group:10001"]').setValue("account:qq_arona:private:9");
    expect(wrapper.emitted("update")?.at(-1)?.[0]).toEqual({
      conversationId: "account:qq_arona:private:9",
      mentionUserIds: []
    });
  });

  it("rejects duplicate and non-numeric mention ids locally", async () => {
    const wrapper = mount(ScheduledTaskTargetRow, {
      props: {
        target: { conversationId: "group:10001", mentionUserIds: ["7"] },
        conversations: [],
        removable: false
      }
    });
    const input = wrapper.get('input[placeholder="输入 QQ 号"]');

    await input.setValue("7");
    await wrapper.get("button.btn").trigger("click");
    expect(wrapper.text()).toContain("该 QQ 号已添加");

    await input.setValue("abc");
    await wrapper.get("button.btn").trigger("click");
    expect(wrapper.text()).toContain("请输入有效的 QQ 号");

    await input.setValue("9007199254740992");
    await wrapper.get("button.btn").trigger("click");
    expect(wrapper.text()).toContain("请输入有效的 QQ 号");
  });

  it("stops accepting mentions after twenty QQ ids", () => {
    const wrapper = mount(ScheduledTaskTargetRow, {
      props: {
        target: {
          conversationId: "group:10001",
          mentionUserIds: Array.from({ length: 20 }, (_, index) => String(index + 1))
        },
        conversations: [],
        removable: false
      }
    });

    expect(wrapper.get('input[placeholder="输入 QQ 号"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("button.btn").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("每个会话最多添加 20 个 @ 对象");
  });
});
