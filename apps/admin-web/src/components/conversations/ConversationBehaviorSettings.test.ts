// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationBehaviorSettings from "./ConversationBehaviorSettings.vue";

describe("ConversationBehaviorSettings", () => {
  it("shows the group-only orchestrator setting and emits explicit updates", async () => {
    const wrapper = mount(ConversationBehaviorSettings, {
      props: {
        conversation: conversation("user_group"),
        replyEnabled: true,
        orchestratorEnabled: true,
        busy: false
      }
    });
    const toggles = wrapper.findAllComponents(ToggleSwitch);

    expect(toggles.map((toggle) => toggle.props("label"))).toEqual(["允许回复", "群聊编排器"]);
    await toggles[0]!.vm.$emit("update:modelValue", false);
    await toggles[1]!.vm.$emit("update:modelValue", false);
    expect(wrapper.emitted("updateReplyEnabled")).toEqual([[false]]);
    expect(wrapper.emitted("updateOrchestratorEnabled")).toEqual([[false]]);
  });

  it("keeps private conversations to the reply setting", () => {
    const wrapper = mount(ConversationBehaviorSettings, {
      props: {
        conversation: conversation("private"),
        replyEnabled: true,
        orchestratorEnabled: true,
        busy: false
      }
    });

    expect(wrapper.findAllComponents(ToggleSwitch).map((toggle) => toggle.props("label"))).toEqual(["允许回复"]);
  });
});

function conversation(scope: "private" | "user_group") {
  return {
    id: scope === "private" ? "private:7" : "group:7",
    scope,
    title: "会话",
    userId: 7,
    ...(scope === "user_group" ? { groupId: 7 } : {}),
    messageCount: 1,
    lastAt: "2026-07-10T00:00:00.000Z",
    lastText: "hello",
    messages: []
  };
}
