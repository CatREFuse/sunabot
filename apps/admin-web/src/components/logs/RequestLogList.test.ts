import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ConversationLogEntry } from "../../types";
import RequestLogList from "./RequestLogList.vue";
import RequestLogTokenUsage from "./RequestLogTokenUsage.vue";

const responseLog: ConversationLogEntry = {
  id: "response-1",
  at: "2026-07-12T08:00:00.000Z",
  category: "model.response",
  action: "responses.complete",
  providerId: "codex",
  model: "gpt-5.6-sol",
  response: { ok: true },
  tokenUsage: {
    input: 8_200,
    output: 1_600,
    cachedInput: 4_100,
    total: 9_800,
    cacheRate: 0.5
  }
};

describe("RequestLogList", () => {
  it("shows normalized Token usage before the raw response details", () => {
    const wrapper = mount(RequestLogList, { props: { logs: [responseLog] } });
    const usage = wrapper.getComponent(RequestLogTokenUsage);

    expect(usage.props("usage")).toEqual(responseLog.tokenUsage);
    expect(usage.text()).toContain("总量");
    expect(usage.text()).toContain("9.8K");
    expect(usage.text()).toContain("输入");
    expect(usage.text()).toContain("8.2K");
    expect(usage.text()).toContain("输出");
    expect(usage.text()).toContain("1.6K");
    expect(usage.text()).toContain("缓存输入");
    expect(usage.text()).toContain("4.1K");
    expect(usage.text()).toContain("缓存率");
    expect(usage.text()).toContain("50%");
    expect(wrapper.get("details summary").text()).toContain("响应体");
  });

  it("keeps legacy and non-model logs compact when no usage is available", () => {
    const wrapper = mount(RequestLogList, {
      props: {
        logs: [{ id: "runtime-1", at: "2026-07-12T08:00:00.000Z", category: "runtime.action", action: "reply.sent" }]
      }
    });

    expect(wrapper.findComponent(RequestLogTokenUsage).exists()).toBe(false);
    expect(wrapper.text()).toContain("回复已发送");
  });

  it("renders a missing cache rate as unavailable", () => {
    const wrapper = mount(RequestLogList, {
      props: {
        logs: [{
          ...responseLog,
          id: "response-empty",
          tokenUsage: { input: 0, output: 20, cachedInput: 0, total: 20, cacheRate: null }
        }]
      }
    });

    const usage = wrapper.get('[aria-label="Token 用量"]');
    expect(usage.text()).toContain("缓存率--");
  });
});
