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
    const summary = wrapper.get("details summary");
    expect(summary.text()).toContain("响应体");
    expect(summary.classes()).toContain("min-h-11");
    expect(wrapper.get('[data-slot="request-direction-marker"]').find("i").exists()).toBe(false);
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

  it("shows specific Chinese titles for orchestration and tool activity", () => {
    const wrapper = mount(RequestLogList, {
      props: {
        logs: [
          { id: "orchestrator-1", at: "2026-07-12T08:00:00.000Z", category: "runtime.action", action: "orchestrator.decision" },
          { id: "tool-1", at: "2026-07-12T08:01:00.000Z", category: "tool.call", action: "generate_img" }
        ]
      }
    });

    expect(wrapper.text()).toContain("群聊编排结果");
    expect(wrapper.text()).toContain("生图");
    expect(wrapper.text()).not.toContain("运行事件");
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

  it("shows an explicitly reported cache miss as zero percent", () => {
    const wrapper = mount(RequestLogList, {
      props: {
        logs: [{
          ...responseLog,
          id: "response-cache-miss",
          tokenUsage: { input: 11_939, output: 73, cachedInput: 0, total: 12_012, cacheRate: 0 }
        }]
      }
    });

    const usage = wrapper.get('[aria-label="Token 用量"]');
    expect(usage.text()).toContain("缓存率0%");
    expect(usage.get('[data-metric="rate"] dd').attributes("title")).toBe("0 / 11,939");
    expect(usage.text()).not.toContain("缓存率--");
  });

  it("matches nested request, response, and metadata text across logs", async () => {
    const wrapper = mount(RequestLogList, {
      props: {
        enableSearch: true,
        logs: [
          {
            id: "request-1",
            at: "2026-07-12T08:00:00.000Z",
            category: "model.request",
            action: "responses.complete",
            request: { input: [{ role: "system", content: "完整最终提示词 ALPHA" }] }
          },
          {
            id: "response-2",
            at: "2026-07-12T08:01:00.000Z",
            category: "model.response",
            action: "chat.completions.complete",
            response: { payload: { choices: [{ message: { content: "模型返回正文 beta" } }] } },
            metadata: { trace: "trace-gamma" }
          }
        ]
      }
    });

    const search = wrapper.get('[data-slot="request-log-search"]');
    await search.setValue("alpha");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("完整最终提示词 ALPHA");
    expect(wrapper.text()).not.toContain("模型返回正文 beta");

    await search.setValue("BETA");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("模型返回正文 beta");

    await search.setValue("trace-gamma");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(1);

    await search.setValue("没有结果");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(0);
    expect(wrapper.text()).toContain("没有匹配的请求日志");
  });
});
