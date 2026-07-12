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
      working_long_term: bucket(500, 16_800),
      user_profile: bucket(200, 4_800)
    }
  }
};

describe("ModelCallStatsPanel", () => {
  it("uses compact metrics with exact localized values", () => {
    const wrapper = mount(ModelCallStatsPanel, {
      props: {
        stats,
        messages: {
          total: 12_345,
          retained: 120,
          visible: 110,
          user: 65,
          assistant: 45,
          internal: 10
        }
      }
    });

    expect(wrapper.text()).toContain("12.3K 条消息");
    expect(wrapper.text()).toContain("2.6K 次");
    expect(wrapper.text()).toContain("128.4K Token");
    expect(wrapper.find('[title="12,345"]').exists()).toBe(true);
    expect(wrapper.find('[title="128,400"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("可见 110");
    expect(wrapper.text()).toContain("保留 120");
    expect(wrapper.text()).toContain("工作与长期记忆");
    expect(wrapper.text()).not.toContain("MODEL CALLS");
  });

  it("uses a dense two-column grid in compact group details", () => {
    const wrapper = mount(ModelCallStatsPanel, { props: { stats, compact: true } });
    const grids = wrapper.findAll(".grid");

    expect(grids[0]?.classes()).toContain("grid-cols-2");
    expect(grids[0]?.classes()).toContain("lg:grid-cols-4");
    expect(grids[1]?.classes()).toContain("grid-cols-2");
  });
});
