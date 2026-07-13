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
  },
  models: [{
    model: "gpt-5.4-mini",
    total: bucket(1_000, 64_000),
    behavior: {
      reply: bucket(600, 48_000),
      orchestrator: bucket(200, 8_000),
      memory: bucket(150, 7_000),
      other: bucket(50, 1_000)
    },
    memory: {
      total: bucket(150, 7_000),
      kinds: {
        working_long_term: bucket(100, 5_000),
        user_profile: bucket(50, 2_000)
      }
    }
  }]
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

  it("filters token usage by model", async () => {
    const wrapper = mount(ModelCallStatsPanel, { props: { stats } });

    await wrapper.get('select[aria-label="筛选模型"]').setValue("gpt-5.4-mini");

    expect(wrapper.text()).toContain("1K 次");
    expect(wrapper.text()).toContain("64K Token");
    expect(wrapper.find('[title="64,000"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("48K Token");
  });

  it("keeps all models selected when unlabeled model calls exist", async () => {
    const unlabeled = {
      ...stats.models![0]!,
      model: "__unlabeled__",
      total: bucket(100, 4_000)
    };
    const wrapper = mount(ModelCallStatsPanel, {
      props: { stats: { ...stats, models: [...(stats.models ?? []), unlabeled] } }
    });

    expect((wrapper.get('select[aria-label="筛选模型"]').element as HTMLSelectElement).value).toBe("");
    expect(wrapper.text()).toContain("2.6K 次");
    expect(wrapper.get('select[aria-label="筛选模型"]').text()).toContain("未标注模型");

    await wrapper.get('select[aria-label="筛选模型"]').setValue("__unlabeled__");
    expect(wrapper.text()).toContain("100 次");
    expect(wrapper.text()).toContain("4K Token");
  });

  it("collapses detail rows while keeping the summary visible", async () => {
    const wrapper = mount(ModelCallStatsPanel, {
      props: {
        stats,
        messages: {
          total: 1_259,
          retained: 1_300,
          visible: 1_200,
          user: 1_200,
          assistant: 35,
          internal: 45
        }
      }
    });
    const toggle = wrapper.get('button[aria-label="收起模型调用"]');

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.text()).toContain("回答");
    expect(wrapper.text()).toContain("1.3K 条消息");

    await toggle.trigger("click");

    expect(wrapper.get('button[aria-label="展开模型调用"]').attributes("aria-expanded")).toBe("false");
    expect(wrapper.text()).toContain("1.3K 条消息");
    expect(wrapper.find('[style*="display: none"]').text()).toContain("回答");
  });
});
