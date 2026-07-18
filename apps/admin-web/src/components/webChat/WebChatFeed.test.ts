// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import WebChatFeed from "./WebChatFeed.vue";

describe("WebChatFeed", () => {
  it("uses alignment, whitespace and dividers without rounded message cards", () => {
    const wrapper = mount(WebChatFeed, {
      props: {
        messages: [
          { id: "u1", role: "user", senderName: "猫老师", text: "你好", at: "2026-07-12T00:00:00.000Z" },
          { id: "a1", role: "assistant", senderName: "普拉娜", text: "我在。", at: "2026-07-12T00:00:01.000Z" }
        ],
        loading: false,
        scrollRevision: 0
      }
    });
    const articles = wrapper.findAll("article");

    expect(articles).toHaveLength(2);
    expect(articles[0]?.classes()).toContain("ml-auto");
    expect(articles[1]?.classes()).toContain("mr-auto");
    expect(articles.every((article) => article.classes().includes("border-t"))).toBe(true);
    expect(articles.every((article) => !article.classes().some((name) => name.startsWith("rounded")))).toBe(true);
  });

  it("scrolls to the latest message when the scroll target changes", async () => {
    const wrapper = mount(WebChatFeed, {
      props: { messages: [], loading: false, scrollRevision: 0 }
    });
    const feed = wrapper.get('[data-slot="web-chat-feed"]').element as HTMLElement;
    let scrollTop = 0;
    Object.defineProperties(feed, {
      scrollHeight: { configurable: true, get: () => 1_200 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } }
    });

    await wrapper.setProps({ scrollRevision: 1 });
    await nextTick();
    expect(scrollTop).toBe(1_200);
  });

  it("uses a generic assistant name when a message has no sender name", () => {
    const wrapper = mount(WebChatFeed, {
      props: {
        messages: [{ id: "a1", role: "assistant", text: "我在。", at: "2026-07-12T00:00:01.000Z" }],
        loading: false,
        scrollRevision: 0
      }
    });

    expect(wrapper.text()).toContain("助手");
    expect(wrapper.text()).not.toContain("普拉娜");
  });
});
