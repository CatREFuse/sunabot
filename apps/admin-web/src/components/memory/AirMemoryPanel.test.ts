// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("../../composables/useAdminApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../composables/useAdminApi")>(),
  apiRequest: mocks.apiRequest
}));

import AirMemoryPanel from "./AirMemoryPanel.vue";

describe("AirMemoryPanel", () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset();
  });

  it("ignores a late response from the previous Agent", async () => {
    const plana = deferred<ReturnType<typeof detail>>();
    const arona = deferred<ReturnType<typeof detail>>();
    mocks.apiRequest
      .mockReturnValueOnce(plana.promise)
      .mockReturnValueOnce(arona.promise);

    const wrapper = mount(AirMemoryPanel, { props: { agentId: "plana" } });
    await flushPromises();
    await wrapper.setProps({ agentId: "arona" });
    await flushPromises();

    arona.resolve(detail("arona", "阿罗娜的场域"));
    await flushPromises();
    plana.resolve(detail("plana", "普拉娜的场域"));
    await flushPromises();

    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      2,
      "/api/agent-files/persona.air?agentId=arona"
    );
    expect(wrapper.get("textarea").element.value).toBe("阿罗娜的场域");
  });

  it("saves the current revision and content in the selected Agent scope", async () => {
    mocks.apiRequest
      .mockResolvedValueOnce(detail("plana", "原文", "rev-1"))
      .mockResolvedValueOnce(detail("plana", "新内容", "rev-2"));
    const wrapper = mount(AirMemoryPanel, { props: { agentId: "plana" } });
    await flushPromises();

    await wrapper.get("textarea").setValue("新内容");
    await wrapper.findAll("button").find((button) => button.text().includes("保存"))!.trigger("click");
    await flushPromises();

    expect(mocks.apiRequest).toHaveBeenLastCalledWith(
      "/api/agent-files/persona.air?agentId=plana",
      {
        method: "PUT",
        body: JSON.stringify({ content: "新内容", revision: "rev-1" })
      }
    );
    expect(wrapper.text()).toContain("已保存");
    expect(wrapper.text()).not.toContain("已同步");
  });
});

function detail(agentId: string, content: string, revision = `${agentId}-revision`) {
  return {
    id: "persona.air",
    title: "场域知识",
    category: "persona",
    kind: "fragment" as const,
    variables: [],
    fileName: "AIR.md",
    revision,
    content
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
