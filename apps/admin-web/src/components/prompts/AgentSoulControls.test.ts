import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSoulControls from "./AgentSoulControls.vue";

const apiBlob = vi.hoisted(() => vi.fn());
const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../composables/useAdminApi", () => ({ apiBlob, apiRequest }));

describe("AgentSoulControls", () => {
  beforeEach(() => {
    apiBlob.mockReset();
    apiRequest.mockReset();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:soul"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exports, previews and confirms an Agent-scoped soul file", async () => {
    apiBlob.mockResolvedValue(new Blob(["{}"], { type: "application/json" }));
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/agents/arona/soul/preview") {
        return Promise.resolve({
          schema: "sunabot.soul",
          version: 1,
          source: { agentId: "plana", name: "普拉娜" },
          targetAgentId: "arona",
          packageSha256: "a".repeat(64),
          targetRevision: "b".repeat(64),
          files: [
            { id: "persona.soul", fileName: "SOUL.md", kind: "fragment", change: "replace" },
            { id: "persona.user", fileName: "USER.md", kind: "fragment", change: "unchanged" }
          ]
        });
      }
      if (path === "/api/agents/arona/soul/import") return Promise.resolve({ ok: true, imported: 2 });
      throw new Error(`Unexpected request: ${path}`);
    });
    const wrapper = mount(AgentSoulControls, {
      props: { agentId: "arona" },
      attachTo: document.body
    });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(apiBlob).toHaveBeenCalledWith("/api/agents/arona/soul/export", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(wrapper.text()).toContain("灵魂文件已导出");

    const input = wrapper.get('input[type="file"]');
    const bytes = new TextEncoder().encode('{"schema":"sunabot.soul"}');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [{
        name: "plana.sunabot-soul.json",
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer
      }]
    });
    await input.trigger("change");
    await flushPromises();

    expect(apiRequest).toHaveBeenCalledWith(
      "/api/agents/arona/soul/preview",
      expect.objectContaining({ method: "POST" })
    );
    const dialog = wrapper.get('[labelledby="soul-import-title"]');
    expect(dialog.text()).toContain("普拉娜 · plana");
    expect(dialog.text()).toContain("目标 · arona");
    expect(dialog.text()).toContain("1 个文件将更新");
    expect(dialog.text()).toContain("SOUL.md");
    const confirm = dialog.findAll("button").find((button) => button.text().includes("确认导入"))!;
    await confirm.trigger("click");
    await flushPromises();

    expect(apiRequest).toHaveBeenLastCalledWith(
      "/api/agents/arona/soul/import",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"targetRevision":"bbbb') })
    );
    expect(wrapper.emitted("imported")).toHaveLength(1);
    expect(wrapper.text()).toContain("灵魂文件已导入");
    wrapper.unmount();
  });

  it("disables both entry points while the prompt editor has local changes", () => {
    const wrapper = mount(AgentSoulControls, { props: { agentId: "arona", disabled: true } });

    expect(wrapper.get('button[type="button"]').attributes("disabled")).toBeDefined();
    expect(wrapper.findAll('button[type="button"]')[1]?.attributes("disabled")).toBeDefined();
    expect(wrapper.get('input[type="file"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("does not open a stale preview after the selected Agent changes", async () => {
    let resolvePreview!: (value: unknown) => void;
    apiRequest.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    const wrapper = mount(AgentSoulControls, {
      props: { agentId: "arona" },
      attachTo: document.body
    });
    const input = wrapper.get('input[type="file"]');
    const bytes = new TextEncoder().encode('{"schema":"sunabot.soul"}');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [{
        name: "plana.sunabot-soul.json",
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer
      }]
    });
    await input.trigger("change");
    await wrapper.setProps({ agentId: "plana" });
    resolvePreview({
      schema: "sunabot.soul",
      version: 1,
      source: { agentId: "plana", name: "普拉娜" },
      targetAgentId: "arona",
      packageSha256: "a".repeat(64),
      targetRevision: "b".repeat(64),
      files: []
    });
    await flushPromises();

    expect(wrapper.find('[labelledby="soul-import-title"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
