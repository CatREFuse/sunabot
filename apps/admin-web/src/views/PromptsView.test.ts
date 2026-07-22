import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PromptsView from "./PromptsView.vue";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../composables/useAdminApi", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
  },
  apiRequest
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function file(id: string, content: string) {
  return {
    id,
    title: id,
    category: "persona",
    kind: "fragment" as const,
    variables: [],
    fileName: `${id}.md`,
    revision: `${id}-r1`,
    content
  };
}

describe("PromptsView", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("ignores a stale file response after the route selects another file", async () => {
    const first = deferred<ReturnType<typeof file>>();
    const second = deferred<ReturnType<typeof file>>();
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/agents/plana/prompt-settings") return Promise.resolve({ overrideSystem: false });
      if (path === "/api/agent-files") return Promise.resolve({ files: [] });
      if (path.endsWith("persona.soul")) return first.promise;
      if (path.endsWith("persona.user")) return second.promise;
      throw new Error(`Unexpected request: ${path}`);
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/agent-prompts/:fileId?", component: PromptsView }]
    });
    await router.push("/agent-prompts/persona.soul");
    await router.isReady();
    const wrapper = mount(RouterView, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();

    await router.push("/agent-prompts/persona.user");
    await flushPromises();
    second.resolve(file("persona.user", "new route content"));
    await flushPromises();
    first.resolve(file("persona.soul", "stale route content"));
    await flushPromises();

    expect(wrapper.get('[aria-label="提示词正文"]').text()).toContain("new route content");
    expect(wrapper.text()).not.toContain("stale route content");
    wrapper.unmount();
  });

  it("loads the selfie prompt through the Agent resource API", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/agents/plana/prompt-settings") return Promise.resolve({ overrideSystem: false });
      if (path === "/api/agent-files") return Promise.resolve({ files: [] });
      if (path === "/api/agent-files/image.selfie-rewrite") {
        return Promise.resolve({
          ...file("image.selfie-rewrite", `${JSON.stringify({
            messages: [{ role: "system", content: "自拍提示词" }],
            response_format: { type: "text" }
          }, null, 2)}\n`),
          kind: "final",
          fileName: "selfie_prompt_rewrite.json"
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/agent-prompts/:fileId?", component: PromptsView }]
    });
    await router.push("/agent-prompts/image.selfie-rewrite");
    await router.isReady();
    const wrapper = mount(RouterView, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();

    expect(apiRequest).toHaveBeenCalledWith("/api/agent-files/image.selfie-rewrite");
    expect(wrapper.get('[aria-label="system 提示词"]').text()).toContain("自拍提示词");
    wrapper.unmount();
  });
});
