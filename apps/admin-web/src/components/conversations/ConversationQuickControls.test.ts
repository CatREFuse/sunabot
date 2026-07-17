import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConversationStatsPayload, ModelCallStatsPayload, TokenUsageBucket } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationOrchestratorStatus from "./ConversationOrchestratorStatus.vue";
import ConversationQuickControls from "./ConversationQuickControls.vue";

const bucket = (requests: number, total: number): TokenUsageBucket => ({
  input: Math.round(total * 0.8),
  output: Math.round(total * 0.2),
  cachedInput: 0,
  cacheRate: null,
  requests,
  total
});

const modelCalls: ModelCallStatsPayload = {
  conversationId: "group:7",
  total: bucket(12, 128_400),
  behavior: {
    reply: bucket(8, 96_000),
    orchestrator: bucket(2, 24_000),
    memory: bucket(1, 7_600),
    other: bucket(1, 800)
  },
  memory: {
    total: bucket(1, 7_600),
    kinds: {
      working_long_term: bucket(1, 7_600),
      user_profile: bucket(0, 0)
    }
  }
};

const stats: ConversationStatsPayload = {
  conversationId: "group:7",
  messages: { total: 24, retained: 20, visible: 18, user: 12, assistant: 6, internal: 2 },
  modelCalls
};

const conversation = {
  id: "group:7",
  scope: "user_group" as const,
  title: "产品讨论群",
  userId: 1,
  groupId: 7,
  replyEnabled: true,
  orchestratorEnabled: true,
  orchestratorStatus: {
    active: true,
    messageCount: 4,
    messageTarget: 21,
    activeWindowMs: 60_000,
    lastMessageAt: new Date().toISOString()
  },
  messageCount: 24,
  lastAt: "2026-07-10T00:00:00.000Z",
  lastText: "hello",
  messages: []
};

describe("ConversationQuickControls", () => {
  it("keeps reply controls outside and summarizes token usage in one widget", async () => {
    const wrapper = shallowMount(ConversationQuickControls, { props: { conversation, stats } });

    expect(wrapper.findAllComponents(ToggleSwitch).map((toggle) => toggle.props("label"))).toEqual(["启动", "编排器"]);
    expect(wrapper.get('[data-slot="token-usage-widget"]').text()).toContain("128.4K");
    expect(wrapper.get('[data-slot="token-usage-widget"]').attributes("title")).toBe("128,400 Token");
    expect(wrapper.findComponent(ConversationOrchestratorStatus).exists()).toBe(true);

    await wrapper.get('[data-slot="token-usage-widget"]').trigger("click");
    expect(wrapper.emitted("usage")).toEqual([[]]);
  });

  it("keeps the orchestrator visible but disabled until replies are started", async () => {
    const wrapper = shallowMount(ConversationQuickControls, {
      props: { conversation: { ...conversation, replyEnabled: false }, stats }
    });
    const toggles = wrapper.findAllComponents(ToggleSwitch);

    expect(toggles.map((toggle) => toggle.props("label"))).toEqual(["启动", "编排器"]);
    expect(toggles[1]!.props("disabled")).toBe(true);
    expect(wrapper.findComponent(ConversationOrchestratorStatus).exists()).toBe(false);

    await toggles[0]!.vm.$emit("update:modelValue", true);
    expect(wrapper.emitted("reply")).toEqual([[true]]);
  });

  it("does not show an orchestrator switch in private conversations", () => {
    const wrapper = shallowMount(ConversationQuickControls, {
      props: {
        conversation: { ...conversation, id: "private:1", scope: "private", groupId: undefined },
        stats: { ...stats, conversationId: "private:1" }
      }
    });

    expect(wrapper.findAllComponents(ToggleSwitch).map((toggle) => toggle.props("label"))).toEqual(["启动"]);
    expect(wrapper.get('[data-slot="token-usage-widget"]').text()).toContain("128.4K");
  });
});
