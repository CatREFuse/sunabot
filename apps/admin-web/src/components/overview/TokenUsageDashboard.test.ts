import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import type { TokenUsageBucket, TokenUsagePayload } from "../../types";
import TokenUsageDashboard from "./TokenUsageDashboard.vue";

const emptyBucket: TokenUsageBucket = {
  input: 0,
  output: 0,
  cachedInput: 0,
  total: 0,
  cacheRate: null,
  requests: 0
};

function usagePayload(): TokenUsagePayload {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ ...emptyBucket, hour }));
  hours[1] = { hour: 1, input: 100, output: 20, cachedInput: 25, total: 120, cacheRate: 0.25, requests: 1 };
  hours[2] = { hour: 2, input: 200, output: 40, cachedInput: 100, total: 240, cacheRate: 0.5, requests: 1 };
  hours[4] = { hour: 4, input: 300, output: 60, cachedInput: 225, total: 360, cacheRate: 0.75, requests: 1 };
  return {
    today: { date: "2026-07-12", input: 12_840, output: 3_260, cachedInput: 6_420, total: 16_100, cacheRate: 0.5, requests: 18 },
    days: [{ date: "2026-07-12", input: 12_840, output: 3_260, cachedInput: 6_420, total: 16_100, cacheRate: 0.5, requests: 18 }],
    hours
  };
}

describe("TokenUsageDashboard", () => {
  it("renders cached input, cache rate and separate hourly cache-rate segments", () => {
    const wrapper = mount(TokenUsageDashboard, { props: { usage: usagePayload(), loading: false } });
    const summary = wrapper.get('[aria-label="今日 Token 统计"]');

    expect(summary.text()).toContain("16.1K");
    expect(summary.text()).toContain("12.8K");
    expect(summary.text()).toContain("缓存输入");
    expect(summary.text()).toContain("6.4K");
    expect(summary.text()).toContain("缓存率");
    expect(summary.text()).toContain("50%");
    expect(summary.get('strong[title="50%"]')).toBeTruthy();
    expect(summary.text()).not.toContain("6,420 / 12,840");

    const chart = wrapper.get('[aria-label="今日每小时 Token 总量与输入缓存率"]');
    expect(chart.findAll(".chart-point")).toHaveLength(3);
    expect(chart.findAll(".chart-line")).toHaveLength(1);
    expect(chart.get(".chart-line").attributes("points")).toBe("47,166 76,122");
    expect(wrapper.get('[aria-label="图例"]').text()).toContain("总 Token");
    expect(wrapper.get('[aria-label="图例"]').text()).toContain("缓存率");
  });

  it("shows an empty cache rate without treating missing input as a zero-percent hit", () => {
    const wrapper = mount(TokenUsageDashboard, { props: { usage: null, loading: true } });
    const rateCard = wrapper.findAll(".token-card--metric").find((card) => card.text().includes("缓存率"));

    expect(rateCard?.text()).toContain("--");
    expect(wrapper.findAll(".chart-point")).toHaveLength(0);
    expect(wrapper.text()).toContain("[LOADING...]");
  });

  it("keeps the newest calendar days visible when usage updates", async () => {
    const wrapper = mount(TokenUsageDashboard, { props: { usage: null, loading: true } });
    const scrollContainer = wrapper.get<HTMLElement>(".calendar-wrap").element;
    Object.defineProperty(scrollContainer, "scrollWidth", { configurable: true, value: 689 });

    await wrapper.setProps({ usage: usagePayload(), loading: false });
    await nextTick();

    expect(scrollContainer.scrollLeft).toBe(689);
  });
});
