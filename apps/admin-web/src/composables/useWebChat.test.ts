// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessagePage } from "../types";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

import { useWebChat } from "./useWebChat";

let wrapper: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  apiRequest.mockReset();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

describe("useWebChat", () => {
  it("loads messages, polls during a send, and applies the completed page", async () => {
    const pending = deferred<ConversationMessagePage>();
    let completed = false;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path !== "/api/web-chat/messages") throw new Error(`Unexpected path: ${path}`);
      if (init?.method === "POST") return pending.promise.then((page) => {
        completed = true;
        return page;
      });
      return Promise.resolve(completed ? completedPage() : initialPage());
    });
    const control = mountControl();
    await flushPromises();

    expect(control.messages.value.map((message) => message.text)).toEqual(["初始消息"]);
    control.draft.value = "检查运行状态";
    const sending = control.send();
    await flushPromises();
    expect(control.sending.value).toBe(true);
    expect(apiRequest).toHaveBeenCalledWith("/api/web-chat/messages", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ text: "检查运行状态" })
    }));

    await vi.advanceTimersByTimeAsync(900);
    await flushPromises();
    expect(apiRequest.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);

    pending.resolve(completedPage());
    await sending;
    expect(control.sending.value).toBe(false);
    expect(control.messages.value.at(-1)?.text).toBe("运行正常");
    expect(control.draft.value).toBe("");
  });

  it("restores the draft and exposes an inline error when sending fails", async () => {
    apiRequest.mockImplementation((_path: string, init?: RequestInit) => init?.method === "POST"
      ? Promise.reject(new Error("模型不可用"))
      : Promise.resolve(initialPage()));
    const control = mountControl();
    await flushPromises();
    control.draft.value = "保留这段内容";

    await control.send();

    expect(control.error.value).toBe("模型不可用");
    expect(control.draft.value).toBe("保留这段内容");
    expect(control.sending.value).toBe(false);
  });

  it("keeps slow polling reads single-flight", async () => {
    const reads = [deferred<ConversationMessagePage>(), deferred<ConversationMessagePage>()];
    const post = deferred<ConversationMessagePage>();
    let readIndex = 0;
    apiRequest.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return post.promise;
      const pending = reads[readIndex++];
      return pending?.promise ?? Promise.resolve(completedPage());
    });
    const control = mountControl();
    control.draft.value = "慢速轮询";
    const sending = control.send();
    await flushPromises();

    expect(readIndex).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(readIndex).toBe(1);

    reads[0]!.resolve(initialPage());
    await flushPromises();
    await vi.advanceTimersByTimeAsync(900);
    expect(readIndex).toBe(2);

    reads[1]!.resolve(initialPage());
    post.resolve(completedPage());
    await sending;
    expect(control.messages.value.at(-1)?.text).toBe("运行正常");
  });
});

function mountControl() {
  let control!: ReturnType<typeof useWebChat>;
  const Harness = defineComponent({
    setup() {
      control = useWebChat();
      return () => h("div");
    }
  });
  wrapper = mount(Harness);
  return control;
}

function initialPage(): ConversationMessagePage {
  return {
    conversationId: "web:admin",
    messages: [{
      id: "web-1",
      role: "user",
      text: "初始消息",
      at: "2026-07-12T00:00:00.000Z"
    }],
    hasMore: false,
    memberNames: {}
  };
}

function completedPage(): ConversationMessagePage {
  return {
    conversationId: "web:admin",
    messages: [
      ...initialPage().messages,
      {
        id: "web-2",
        role: "assistant",
        text: "运行正常",
        at: "2026-07-12T00:00:02.000Z"
      }
    ],
    hasMore: false,
    memberNames: {}
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
