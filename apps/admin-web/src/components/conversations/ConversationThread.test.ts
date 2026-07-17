import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ConversationMessageBubble from "./ConversationMessageBubble.vue";
import ConversationOrchestratorStatus from "./ConversationOrchestratorStatus.vue";
import ConversationThread from "./ConversationThread.vue";
import RequestLogList from "../logs/RequestLogList.vue";

describe("ConversationThread", () => {
  it("scrolls to the latest message when a conversation first loads", async () => {
    const conversation = { id: "group:7", scope: "user_group" as const, title: "群聊", userId: 1, groupId: 7, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "hello", messages: [] };
    const wrapper = shallowMount(ConversationThread, {
      props: {
        conversation,
        messages: [],
        logs: [],
        hasMore: false,
        loadingMessages: false,
        loadingLogs: false,
        error: ""
      }
    });
    const viewport = wrapper.get('[data-slot="message-viewport"]').element as HTMLElement;
    let scrollTop = 0;
    let scrollHeight = 1_200;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } }
    });

    await wrapper.setProps({
      messages: [{ id: "m1", role: "user", userId: 1, text: "最新消息", at: "2026-07-10T00:00:00.000Z" }]
    });
    await nextTick();

    expect(scrollTop).toBe(1_200);

    scrollHeight = 1_600;
    await wrapper.get('[data-slot="message-content"]').trigger("load");
    await nextTick();
    expect(scrollTop).toBe(1_600);
  });

  it("renders quoted images and request metadata", async () => {
    const wrapper = shallowMount(ConversationThread, {
      props: {
        conversation: { id: "c1", scope: "private", title: "会话", userId: 1, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "hello", messages: [] },
        messages: [{ id: "m1", role: "user", userId: 1, senderName: "备用名称", senderNickname: "好吃的猫头菇", senderCard: "爱上火车张作霖", text: "hello", at: "2026-07-10T00:00:00.000Z", imageUrls: ["https://example.com/message.png"], quoteReferences: [{ messageId: 7, senderName: "Alice", text: "quoted", imageUrls: ["https://example.com/quote.png"] }] }],
        logs: [{ id: "log-1", at: "2026-07-10T00:00:00.000Z", category: "provider", action: "respond", metadata: { traceId: "trace-7", retries: 1 } }],
        hasMore: false,
        loadingMessages: false,
        loadingLogs: false,
        error: ""
      }
    });

    const bubble = wrapper.getComponent(ConversationMessageBubble);
    const renderedBubble = shallowMount(ConversationMessageBubble, {
      props: { message: bubble.props("message"), conversation: bubble.props("conversation") }
    });
    expect(renderedBubble.findAllComponents(AuthenticatedImage).map((image) => image.props("src"))).toEqual([
      "https://example.com/quote.png",
      "https://example.com/message.png"
    ]);
    expect(renderedBubble.text().match(/爱上火车张作霖/g)).toHaveLength(1);
    expect(renderedBubble.text()).not.toContain("群名片 爱上火车张作霖");
    expect(renderedBubble.text()).toContain("QQ 昵称 好吃的猫头菇");
    expect(renderedBubble.text()).toContain("QQ 1");
    await wrapper.get('button[aria-label="请求日志"]').trigger("click");
    expect(wrapper.getComponent(RequestLogList).props("logs")).toEqual([
      expect.objectContaining({ metadata: { traceId: "trace-7", retries: 1 } })
    ]);
  });

  it("does not repeat a nickname or QQ number already used as the primary name", () => {
    const conversation = { id: "c1", scope: "private" as const, title: "会话", userId: 1, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "hello", messages: [] };
    const nicknameBubble = shallowMount(ConversationMessageBubble, {
      props: {
        conversation,
        message: { id: "m1", role: "user", userId: 1, senderName: "备用名称", senderNickname: "好吃的猫头菇", text: "hello", at: "2026-07-10T00:00:00.000Z" }
      }
    });
    const numberBubble = shallowMount(ConversationMessageBubble, {
      props: {
        conversation,
        message: { id: "m2", role: "user", userId: 1, senderName: "1", text: "hello", at: "2026-07-10T00:00:00.000Z" }
      }
    });

    expect(nicknameBubble.get("header").text()).not.toContain("QQ 昵称 好吃的猫头菇");
    expect(numberBubble.get("header").text()).not.toContain("QQ 1");
  });

  it("hides pure image markers and renders recognizable QQ mentions", () => {
    const conversation = { id: "group:7", scope: "user_group" as const, title: "群聊", userId: 1, groupId: 7, messageCount: 2, lastAt: "2026-07-10T00:00:00.000Z", lastText: "hello", messages: [] };
    const imageBubble = shallowMount(ConversationMessageBubble, {
      props: {
        conversation,
        message: { id: "m1", role: "user", userId: 1, text: "[图片]", at: "2026-07-10T00:00:00.000Z", imageUrls: ["https://example.com/image.png"] }
      }
    });
    const mentionBubble = shallowMount(ConversationMessageBubble, {
      props: {
        conversation,
        memberNames: { "1309367301": "飞行雪绒" },
        message: { id: "m2", role: "user", userId: 1, text: "@1309367301 现在开始", at: "2026-07-10T00:00:00.000Z" }
      }
    });

    expect(imageBubble.text()).not.toContain("[图片]");
    expect(imageBubble.findComponent(AuthenticatedImage).exists()).toBe(true);
    expect(mentionBubble.text()).toContain("@飞行雪绒 (1309367301) 现在开始");
  });

  it("renders orchestrator decisions as user-invisible conversation results", () => {
    const wrapper = shallowMount(ConversationMessageBubble, {
      props: {
        conversation: { id: "group:7", scope: "user_group", title: "群聊", userId: 1, groupId: 7, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "编排器结果", messages: [] },
        message: {
          id: "decision-1",
          role: "assistant",
          text: "编排器结果",
          at: "2026-07-10T00:00:10.000Z",
          senderName: "普拉娜",
          selfId: 123456,
          eventKind: "orchestrator_decision",
          visibility: "internal",
          orchestratorDecision: {
            shouldReply: false,
            reason: "当前消息只是群友闲聊，没有需要普拉娜介入的内容。",
            raw: '{"should_reply":false,"reason":"当前消息只是群友闲聊，没有需要普拉娜介入的内容。"}'
          }
        }
      }
    });

    expect(wrapper.text()).toContain("编排器结果");
    expect(wrapper.text()).toContain("保持沉默");
    expect(wrapper.text()).toContain("用户不可见");
    expect(wrapper.text()).toContain("当前消息只是群友闲聊，没有需要普拉娜介入的内容。");
    expect(wrapper.get("article").classes()).toContain("ml-auto");
    expect(wrapper.get("article").classes()).toContain("flex-row-reverse");
    expect(wrapper.getComponent({ name: "IdentityAvatar" }).props()).toMatchObject({
      name: "普拉娜",
      src: "/api/media/qq-avatar?kind=user&id=123456"
    });
  });

  it("renders failed orchestrator decisions with a log entry point", () => {
    const wrapper = shallowMount(ConversationMessageBubble, {
      props: {
        conversation: { id: "group:7", scope: "user_group", title: "群聊", userId: 1, groupId: 7, selfId: 123456, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "编排器结果", messages: [] },
        message: {
          id: "decision-failed",
          role: "assistant",
          text: "编排器结果",
          at: "2026-07-10T00:00:10.000Z",
          senderName: "普拉娜",
          selfId: 123456,
          eventKind: "orchestrator_decision",
          visibility: "internal",
          logRunId: "run-failed",
          orchestratorDecision: {
            status: "failed",
            shouldReply: false,
            reason: "编排器判断失败，请查看请求日志。",
            raw: "provider unavailable"
          }
        }
      }
    });

    expect(wrapper.text()).toContain("判断失败");
    expect(wrapper.text()).not.toContain("保持沉默");
    expect(wrapper.text()).toContain("编排器判断失败，请查看请求日志。");
    expect(wrapper.get("button").text()).toBe("查看请求日志");
  });

  it("renders a running reply as a typing bubble with request logs", async () => {
    const wrapper = shallowMount(ConversationMessageBubble, {
      props: {
        conversation: { id: "c1", scope: "private", title: "会话", userId: 1, selfId: 9, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "正在输入…", messages: [] },
        message: {
          id: "pending-1",
          role: "assistant",
          text: "正在输入…",
          at: "2026-07-10T00:00:10.000Z",
          senderName: "普拉娜",
          selfId: 9,
          requestStatus: "running",
          logRunId: "run-search"
        }
      }
    });

    expect(wrapper.get('[data-slot="typing-indicator"]').attributes("aria-label")).toBe("正在输入");
    expect(wrapper.text()).toContain("正在输入");
    expect(wrapper.find('[data-slot="message-trace"]').exists()).toBe(false);
    expect(wrapper.get("button").text()).toBe("查看请求日志");

    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("logs")).toEqual([["run-search"]]);
  });

  it.each([
    ["text", "text"],
    ["assistant_text", "assistant_text"],
    ["async_tool_dispatch", "dispatch_message"],
    ["async_tool_callback", "async_tool_callback"]
  ] as const)("renders the %s message origin", (messageOrigin, label) => {
    const wrapper = shallowMount(ConversationMessageBubble, {
      props: {
        conversation: { id: "c1", scope: "private", title: "会话", userId: 1, selfId: 9, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "完成", messages: [] },
        message: {
          id: `message-${messageOrigin}`,
          role: "assistant",
          text: "完成",
          at: "2026-07-10T00:00:10.000Z",
          senderName: "普拉娜",
          selfId: 9,
          messageOrigin
        }
      }
    });

    const trace = wrapper.get('[data-slot="message-trace"]');
    expect(trace.get('[data-slot="message-origin"]').text()).toContain(label);
  });

  it("shows unique non-text tools beside the request log entry", async () => {
    const wrapper = shallowMount(ConversationMessageBubble, {
      props: {
        conversation: { id: "c1", scope: "private", title: "会话", userId: 1, selfId: 9, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "完成", messages: [] },
        message: {
          id: "message-tools",
          role: "assistant",
          text: "完成",
          at: "2026-07-10T00:00:10.000Z",
          senderName: "普拉娜",
          selfId: 9,
          messageOrigin: "text",
          toolNames: ["memory_recall", "websearch", "memory_recall", "text", ""],
          logRunId: "run-tools"
        }
      }
    });

    const trace = wrapper.get('[data-slot="message-trace"]');
    expect(trace.get('[data-slot="message-origin"]').text()).toContain("text");
    expect(trace.findAll('[data-slot="message-tool"]').map((tool) => tool.text())).toEqual(["memory_recall", "websearch"]);
    expect(trace.text()).toContain("本轮工具");
    expect(trace.get("button").text()).toBe("查看请求日志");

    await trace.get("button").trigger("click");
    expect(wrapper.emitted("logs")).toEqual([["run-tools"]]);
  });

  it("marks assistant messages without recorded provenance as unknown", () => {
    const wrapper = shallowMount(ConversationMessageBubble, {
      props: {
        conversation: { id: "c1", scope: "private", title: "会话", userId: 1, selfId: 9, messageCount: 1, lastAt: "2026-07-10T00:00:00.000Z", lastText: "旧消息", messages: [] },
        message: {
          id: "legacy-message",
          role: "assistant",
          text: "旧消息",
          at: "2026-07-10T00:00:10.000Z",
          senderName: "普拉娜",
          selfId: 9
        }
      }
    });

    expect(wrapper.get('[data-slot="message-origin"]').text()).toContain("未记录");
  });

  it("shows an independent orchestrator toggle after user-group replies are enabled", async () => {
    const conversation = {
      id: "group:7",
      scope: "user_group" as const,
      title: "群聊",
      userId: 1,
      groupId: 7,
      replyEnabled: false,
      orchestratorEnabled: true,
      orchestratorStatus: {
        active: true,
        messageCount: 4,
        messageTarget: 21,
        activeWindowMs: 60_000,
        lastMessageAt: "2026-07-10T00:00:00.000Z"
      },
      messageCount: 1,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "hello",
      messages: []
    };
    const wrapper = shallowMount(ConversationThread, {
      props: {
        conversation,
        messages: [],
        logs: [],
        hasMore: false,
        loadingMessages: false,
        loadingLogs: false,
        error: ""
      }
    });

    expect(wrapper.findAllComponents(ToggleSwitch).map((toggle) => toggle.props("label"))).toEqual(["启用"]);
    expect(wrapper.findComponent(ConversationOrchestratorStatus).exists()).toBe(false);

    await wrapper.setProps({ conversation: { ...conversation, replyEnabled: true } });
    const toggles = wrapper.findAllComponents(ToggleSwitch);
    expect(toggles.map((toggle) => toggle.props("label"))).toEqual(["启用", "编排器"]);
    expect(wrapper.getComponent(ConversationOrchestratorStatus).props("status")).toEqual(conversation.orchestratorStatus);

    await toggles[1]!.vm.$emit("update:modelValue", false);
    expect(wrapper.emitted("orchestrator")).toEqual([[false]]);
  });

  it("locks both actions while saving and renders action feedback inline", async () => {
    const conversation = {
      id: "group:7",
      scope: "user_group" as const,
      title: "群聊",
      userId: 1,
      groupId: 7,
      replyEnabled: true,
      orchestratorEnabled: true,
      messageCount: 1,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "hello",
      messages: []
    };
    const wrapper = shallowMount(ConversationThread, {
      props: {
        conversation,
        messages: [],
        logs: [],
        hasMore: false,
        loadingMessages: false,
        loadingLogs: false,
        error: "",
        mutationLocked: true,
        replyBusy: true,
        orchestratorError: "保存失败，已重新读取当前状态"
      }
    });

    const toggles = wrapper.findAllComponents(ToggleSwitch);
    expect(toggles.map((toggle) => toggle.props("disabled"))).toEqual([true, true]);
    expect(wrapper.get('[role="status"]').text()).toBe("保存中");
    expect(wrapper.get('[role="alert"]').text()).toBe("保存失败，已重新读取当前状态");

    await toggles[0]!.vm.$emit("update:modelValue", false);
    await toggles[1]!.vm.$emit("update:modelValue", false);
    expect(wrapper.emitted("reply")).toBeUndefined();
    expect(wrapper.emitted("orchestrator")).toBeUndefined();

    await wrapper.setProps({ mutationLocked: false, replyBusy: false });
    await wrapper.findAllComponents(ToggleSwitch)[0]!.vm.$emit("update:modelValue", false);
    expect(wrapper.emitted("reply")).toEqual([[false]]);
  });
});
