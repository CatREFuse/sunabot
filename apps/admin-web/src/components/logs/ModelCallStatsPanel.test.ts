import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ModelCallStatsPayload, TokenUsageBucket } from "../../types";
import ModelCallStatsPanel from "./ModelCallStatsPanel.vue";

const bucket = (requests: number, total: number): TokenUsageBucket => ({
  input: Math.round(total * 0.8),
  output: Math.round(total * 0.2),
  cachedInput: 0,
  cacheRate: null,
  total,
  requests
});

const stats: ModelCallStatsPayload = {
  conversationId: null,
  total: bucket(2_600, 128_400),
  behavior: {
    reply: bucket(1_200, 82_000),
    orchestrator: bucket(600, 24_000),
    memory: bucket(700, 21_600),
    other: bucket(100, 800)
  },
  memory: {
    total: bucket(700, 21_600),
    kinds: {
      working: bucket(300, 9_600),
      long_term: bucket(200, 7_200),
      user_profile: bucket(200, 4_800)
    }
  }
};

describe("ModelCallStatsPanel", () => {
  it("uses compact metrics with exact localized values", () => {
    const wrapper = mount(ModelCallStatsPanel, { props: { stats, messages: 12_345 } });

    expect(wrapper.text()).toContain("12.3K 条消息");
    expect(wrapper.text()).toContain("2.6K 次");
    expect(wrapper.text()).toContain("128.4K Token");
    expect(wrapper.find('[title="12,345"]').exists()).toBe(true);
    expect(wrapper.find('[title="128,400"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("MODEL CALLS");
  });
});
