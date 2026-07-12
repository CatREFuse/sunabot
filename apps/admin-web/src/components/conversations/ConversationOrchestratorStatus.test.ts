import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversationOrchestratorStatus from "./ConversationOrchestratorStatus.vue";

describe("ConversationOrchestratorStatus", () => {
  afterEach(() => vi.useRealTimers());

  it("shows activation, message progress and a live activity timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-10T00:00:12.000Z");
    const wrapper = mount(ConversationOrchestratorStatus, {
      props: {
        status: {
          active: true,
          messageCount: 7,
          messageTarget: 21,
          activeWindowMs: 60_000,
          lastMessageAt: "2026-07-10T00:00:00.000Z"
        }
      }
    });

    expect(wrapper.text()).toContain("编排器状态");
    expect(wrapper.text()).toContain("已激活");
    expect(wrapper.text()).toContain("消息 7 / 21");
    expect(wrapper.text()).toContain("时间 12 / 60 秒");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper.text()).toContain("时间 13 / 60 秒");
  });

  it("shows judging when the idle timer reaches its target", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-10T00:01:00.000Z");
    const wrapper = mount(ConversationOrchestratorStatus, {
      props: {
        status: {
          active: true,
          messageCount: 3,
          messageTarget: 21,
          activeWindowMs: 60_000,
          lastMessageAt: "2026-07-10T00:00:00.000Z"
        }
      }
    });

    expect(wrapper.text()).toContain("判断中");
    expect(wrapper.text()).not.toContain("消息");
    expect(wrapper.text()).not.toContain("时间");
    expect(wrapper.text()).not.toContain("60+");
  });

  it("shows judging when the message target is reached", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-10T00:00:12.000Z");
    const wrapper = mount(ConversationOrchestratorStatus, {
      props: {
        status: {
          active: true,
          messageCount: 21,
          messageTarget: 21,
          activeWindowMs: 60_000,
          lastMessageAt: "2026-07-10T00:00:00.000Z"
        }
      }
    });

    expect(wrapper.text()).toContain("判断中");
    expect(wrapper.text()).not.toContain("消息");
    expect(wrapper.text()).not.toContain("时间");
  });

  it("does not show trigger counters while inactive", () => {
    const wrapper = mount(ConversationOrchestratorStatus, {
      props: {
        status: {
          active: false,
          messageCount: 7,
          messageTarget: 21,
          activeWindowMs: 60_000,
          lastMessageAt: "2026-07-10T00:00:00.000Z"
        }
      }
    });

    expect(wrapper.text()).toContain("编排器状态");
    expect(wrapper.text()).toContain("未激活");
    expect(wrapper.text()).not.toContain("消息");
    expect(wrapper.text()).not.toContain("时间");
  });
});
