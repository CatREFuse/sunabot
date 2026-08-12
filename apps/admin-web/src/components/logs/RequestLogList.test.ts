import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { apiRequest } from "../../composables/useAdminApi";
import { describe, expect, it, vi } from "vitest";
import type { ConversationLogEntry } from "../../types";
import RequestLogDetailDialog from "./RequestLogDetailDialog.vue";
import RequestLogList from "./RequestLogList.vue";
import RequestLogTokenUsage from "./RequestLogTokenUsage.vue";

vi.mock("../../composables/useAdminApi", () => ({
  apiRequest: vi.fn().mockResolvedValue({ logs: [] })
}));

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
  it("shows normalized Token usage before the raw response details", async () => {
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
    await wrapper.get('[aria-label="查看Responses 模型调用请求详情"]').trigger("click");
    await nextTick();
    const detail = wrapper.getComponent(RequestLogDetailDialog);
    expect(detail.props("open")).toBe(true);
    expect(detail.text()).toContain("RESPONSE BODY");
    expect(detail.text()).toContain("ok");
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
    expect(wrapper.text()).not.toContain("模型返回正文 beta");
    await wrapper.get('[aria-label="查看Responses 模型调用请求详情"]').trigger("click");
    await nextTick();
    expect(wrapper.getComponent(RequestLogDetailDialog).text()).toContain("完整最终提示词 ALPHA");

    await search.setValue("BETA");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("chat.completions.complete");
    await wrapper.get('[aria-label="查看兼容模型调用请求详情"]').trigger("click");
    await nextTick();
    expect(wrapper.getComponent(RequestLogDetailDialog).text()).toContain("模型返回正文 beta");

    await search.setValue("trace-gamma");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(1);

    await search.setValue("没有结果");
    expect(wrapper.findAll('[data-slot="request-log-item"]')).toHaveLength(0);
    expect(wrapper.text()).toContain("没有匹配的请求日志");
  });

  it("marks failed retries and opens the structured request inspector", async () => {
    const wrapper = mount(RequestLogList, {
      props: {
        logs: [{
          id: "failed-1",
          at: "2026-07-12T08:00:00.000Z",
          category: "model.response",
          action: "responses.complete",
          request: { input: "hello" },
          response: { ok: false, status: 503, error: "temporary" },
          metadata: { transportAttempt: 2, maxTransportAttempts: 3 },
          presentation: {
            businessNode: "private_conversation",
            businessNodes: ["private_conversation"],
            status: "error",
            attempt: 2,
            maxAttempts: 3,
            retryCount: 1,
            willRetry: true
          }
        }]
      }
    });

    expect(wrapper.get('[data-slot="request-log-item"]').attributes("data-status")).toBe("error");
    expect(wrapper.text()).toContain("[ERROR]");
    expect(wrapper.text()).toContain("RETRY 1 · 2/3");
    await wrapper.get('[aria-label="查看Responses 模型调用请求详情"]').trigger("click");
    await nextTick();
    const detail = wrapper.getComponent(RequestLogDetailDialog);
    expect(detail.text()).toContain("REQUEST BODY");
    expect(detail.text()).toContain("TOOL CALL");
    expect(detail.text()).toContain("RESPONSE BODY");
    expect(detail.text()).toContain("METADATA");
  });

  it("replaces the page fallback with the bounded cross-page run trace", async () => {
    const selectedResponse: ConversationLogEntry = {
      ...responseLog,
      id: "trace-response",
      metadata: { runId: "trace-1" }
    };
    vi.mocked(apiRequest).mockResolvedValueOnce({
      logs: [
        {
          id: "trace-request",
          at: "2026-07-12T08:00:00.000Z",
          category: "model.request",
          action: "responses.complete",
          request: { input: "cross-page request" },
          metadata: { runId: "trace-1" }
        },
        {
          id: "trace-tool",
          at: "2026-07-12T08:00:01.000Z",
          category: "tool.call",
          action: "read_air",
          request: { callId: "call-cross-page", arguments: {} },
          response: { ok: true },
          metadata: { runId: "trace-1" }
        },
        selectedResponse
      ]
    });
    const wrapper = mount(RequestLogList, { props: { logs: [selectedResponse] } });

    await wrapper.get('[aria-label="查看Responses 模型调用请求详情"]').trigger("click");
    await flushPromises();

    const detail = wrapper.getComponent(RequestLogDetailDialog);
    expect(detail.text()).toContain("cross-page request");
    expect(detail.text()).toContain("read_air");
    expect(detail.text()).toContain("call-cross-page");
  });
});
