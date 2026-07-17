import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConversationStatsPayload, TokenUsageBucket } from "../../types";
import ModelCallStatsPanel from "../logs/ModelCallStatsPanel.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationSidePanel from "./ConversationSidePanel.vue";

const bucket = (requests: number, total: number): TokenUsageBucket => ({
  input: total,
  output: 0,
  cachedInput: 0,
  cacheRate: null,
  requests,
  total
});

const stats: ConversationStatsPayload = {
  conversationId: "group:7",
  messages: { total: 24, retained: 20, visible: 18, user: 12, assistant: 6, internal: 2 },
  modelCalls: {
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
  }
};

const conversation = {
  id: "group:7",
  scope: "user_group" as const,
  title: "产品讨论群",
  userId: 1,
  groupId: 7,
  replyEnabled: true,
  orchestratorEnabled: true,
  messageCount: 24,
  lastAt: "2026-07-10T00:00:00.000Z",
  lastText: "hello",
  messages: []
};

describe("ConversationSidePanel", () => {
  it("places the settings close action at the top left", async () => {
    const wrapper = mount(ConversationSidePanel, {
      props: { open: true, panel: "settings", conversation, stats },
      global: { stubs: { Teleport: true } }
    });
    const header = wrapper.get('[data-slot="conversation-side-panel"] header');
    const close = header.get('button[aria-label="关闭会话设置"]');

    expect(header.element.firstElementChild).toBe(close.element);
    expect(wrapper.findAllComponents(ToggleSwitch).map((toggle) => toggle.props("label"))).toEqual(["启动", "编排器"]);
    expect(wrapper.get('button[aria-pressed="true"]').text()).toBe("回复");
    expect(wrapper.get('button[aria-pressed="false"]').text()).toBe("工具权限");

    await close.trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
  });

  it("shows full token details only inside the usage panel", () => {
    const wrapper = mount(ConversationSidePanel, {
      props: { open: true, panel: "usage", conversation, stats },
      global: { stubs: { Teleport: true } }
    });
    const header = wrapper.get('[data-slot="conversation-side-panel"] header');
    const close = header.get('button[aria-label="关闭 Token 消耗详情"]');
    const modelStats = wrapper.getComponent(ModelCallStatsPanel);

    expect(header.element.firstElementChild).toBe(close.element);
    expect(modelStats.props("collapsible")).toBe(false);
    expect(modelStats.text()).toContain("128.4K Token");
    wrapper.unmount();
  });
});
