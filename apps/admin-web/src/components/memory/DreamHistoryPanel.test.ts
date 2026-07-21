import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DreamHistoryPanel from "./DreamHistoryPanel.vue";
import type { DreamHistoryItem } from "../../composables/useDreams";

const items: DreamHistoryItem[] = [
  {
    id: "dream-latest",
    date: "2026-07-20",
    status: "completed",
    dreamText: "我沿着潮湿的石阶走进旧车站，远处的灯和今天未完成的信慢慢连在一起。",
    scheduledFor: "2026-07-20T04:00:00.000+08:00",
    completedAt: "2026-07-20T04:02:00.000+08:00",
    personalityChanged: true,
    summary: { merged: 2, archived: 1, promoted: 1 }
  },
  {
    id: "dream-older",
    date: "2026-07-19",
    status: "completed",
    dreamText: "较早的梦境",
    scheduledFor: "2026-07-19T04:00:00.000+08:00"
  }
];

describe("DreamHistoryPanel", () => {
  it("shows the latest dream and expands older history on demand", async () => {
    const wrapper = mount(DreamHistoryPanel, {
      props: {
        items,
        loading: false,
        error: "",
        timeZone: "Asia/Shanghai",
        nextScheduledFor: "2026-07-21T04:00:00.000+08:00",
        sortField: "updatedAt",
        sortDirection: "desc",
        triggering: false,
        triggerStatus: "",
        triggerStatusKind: ""
      }
    });

    expect(wrapper.text()).toContain("我沿着潮湿的石阶走进旧车站");
    expect(wrapper.text()).toContain("合并 2 · 归档 1 · 转存 1");
    expect(wrapper.text()).toContain("人格已微调");
    expect(wrapper.text()).not.toContain("较早的梦境");

    const toggle = wrapper.get('button[aria-expanded="false"]');
    await toggle.trigger("click");

    expect(wrapper.text()).toContain("较早的梦境");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.findAll("article")).toHaveLength(2);
  });

  it("emits refresh and keeps error and empty states readable", async () => {
    const wrapper = mount(DreamHistoryPanel, {
      props: {
        items: [], loading: false, error: "服务暂不可用", timeZone: "",
        sortField: "updatedAt", sortDirection: "desc",
        triggering: false, triggerStatus: "触发失败", triggerStatusKind: "error"
      }
    });

    expect(wrapper.get('[role="alert"]').text()).toBe("服务暂不可用");
    expect(wrapper.text()).toContain("还没有梦境");
    await wrapper.get('button[aria-label="刷新梦境"]').trigger("click");
    expect(wrapper.emitted("refresh")).toEqual([[]]);
    await wrapper.get("button.btn-primary").trigger("click");
    expect(wrapper.emitted("trigger")).toEqual([[]]);
  });

  it("sorts dream history by the selected direction and keeps recall-time order stable", async () => {
    const wrapper = mount(DreamHistoryPanel, {
      props: {
        items,
        loading: false,
        error: "",
        timeZone: "Asia/Shanghai",
        sortField: "createdAt",
        sortDirection: "asc",
        triggering: false,
        triggerStatus: "",
        triggerStatusKind: ""
      }
    });

    expect(wrapper.text()).toContain("较早的梦境");
    expect(wrapper.text()).not.toContain("我沿着潮湿的石阶走进旧车站");
    await wrapper.get('button[aria-expanded="false"]').trigger("click");
    expect(wrapper.findAll("article").map((article) => article.text())).toEqual([
      expect.stringContaining("较早的梦境"),
      expect.stringContaining("我沿着潮湿的石阶走进旧车站")
    ]);

    await wrapper.setProps({ sortField: "lastRecalledAt", sortDirection: "desc" });
    expect(wrapper.findAll("article").map((article) => article.text())).toEqual([
      expect.stringContaining("我沿着潮湿的石阶走进旧车站"),
      expect.stringContaining("较早的梦境")
    ]);
  });

  it("disables manual Dream actions while a run is in progress", () => {
    const wrapper = mount(DreamHistoryPanel, {
      props: {
        items: [], loading: false, error: "", timeZone: "Asia/Shanghai",
        sortField: "updatedAt", sortDirection: "desc",
        triggering: true, triggerStatus: "", triggerStatusKind: ""
      }
    });

    expect(wrapper.get("button.btn-primary").text()).toContain("做梦中");
    expect(wrapper.get("button.btn-primary").attributes("disabled")).toBeDefined();
    expect(wrapper.get('button[aria-label="刷新梦境"]').attributes("disabled")).toBeDefined();
  });
});
