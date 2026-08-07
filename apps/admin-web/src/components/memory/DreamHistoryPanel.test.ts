import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DreamHistoryPanel from "./DreamHistoryPanel.vue";

function props(attemptCount: number, nextRetryAt?: string) {
  return {
    items: [{
      id: `dream-run-${attemptCount}`,
      date: "2026-07-20",
      status: "failed" as const,
      scheduledFor: "2026-07-20T04:00:00.000Z",
      attemptCount,
      maxAttempts: 3 as const,
      errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
      errorText: "Dream output contract is invalid.",
      ...(nextRetryAt ? { nextRetryAt } : {}),
      failedAt: "2026-07-20T04:05:00.000Z"
    }],
    loading: false,
    error: "",
    timeZone: "Asia/Shanghai",
    nextScheduledFor: "2026-07-21T04:00:00.000Z",
    sortField: "updatedAt" as const,
    sortDirection: "desc" as const,
    triggering: false,
    triggerStatus: "",
    triggerStatusKind: "" as const
  };
}

describe("DreamHistoryPanel", () => {
  it("shows a pending contract retry with its attempt, code, time, and manual trigger", async () => {
    const wrapper = mount(DreamHistoryPanel, {
      props: props(1, "2026-07-20T04:20:00.000Z")
    });

    expect(wrapper.text()).toContain("输出格式未通过 · 第 1/3 次 · 等待重试");
    expect(wrapper.text()).toContain("DREAM_OUTPUT_CONTRACT_INVALID");
    expect(wrapper.get('[data-testid="dream-retry-time"]').text()).toContain("12:20");
    expect(wrapper.get("button.btn-primary").text()).toContain("立即做梦");

    await wrapper.get("button.btn-primary").trigger("click");
    expect(wrapper.emitted("trigger")).toHaveLength(1);
  });

  it("shows the terminal message after the third contract failure", () => {
    const wrapper = mount(DreamHistoryPanel, {
      props: props(3)
    });

    expect(wrapper.text()).toContain("Dream 输出格式连续 3 次未通过");
    expect(wrapper.text()).toContain("DREAM_OUTPUT_CONTRACT_INVALID");
    expect(wrapper.text()).not.toContain("等待重试");
    expect(wrapper.find('[data-testid="dream-retry-time"]').exists()).toBe(false);
  });

  it("keeps manual Dream available after completion without exposing a zero-addition reason", async () => {
    const completed = {
      ...props(1),
      items: [{
        id: "dream-run-completed",
        date: "2026-07-20",
        status: "completed" as const,
        scheduledFor: "2026-07-20T04:00:00.000Z",
        completedAt: "2026-07-20T04:08:00.000Z",
        attemptCount: 1,
        maxAttempts: 3 as const,
        dreamText: "梦见雨声停在旧车站。",
        summary: {
          workingMemoryReduced: 2,
          longTermAdded: 0
        }
      }]
    };
    const wrapper = mount(DreamHistoryPanel, { props: completed });

    expect(wrapper.text()).toContain("工作记忆减少 2 · 长期记忆新增 0");
    expect(wrapper.text()).not.toContain("候选事实已经存在于长期记忆。");
    expect(wrapper.text()).not.toContain("人格");
    expect(wrapper.get("button.btn-primary").attributes("disabled")).toBeUndefined();

    await wrapper.get("button.btn-primary").trigger("click");
    expect(wrapper.emitted("trigger")).toHaveLength(1);
  });
});
