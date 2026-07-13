import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotToolSettingsDraft } from "../../types";
import ToolCatalogSettings from "./ToolCatalogSettings.vue";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

function toolsDraft(): BotToolSettingsDraft {
  return {
    maxCalls: 20,
    overrides: {},
    websearch: {
      provider: "tavily",
      tavilyApiKey: "",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "TAVILY_API_KEY",
      maxResults: 5,
      removeTavilyApiKeyIndexes: []
    },
    codex: {
      enabled: true,
      model: "gpt-5.4-mini",
      codexExecutable: "auto",
      timeoutMs: 900_000,
      maxConcurrency: 2
    },
    generateImg: {
      provider: "codex-image-gen",
      size: "1024x1024",
      resolution: "1K",
      quality: "high"
    }
  };
}

function bashDraft() {
  return {
    enabled: false,
    allowGroup: false,
    adminOnly: true,
    workspaceOnly: true,
    blockedKeywords: []
  };
}

const tools = [
  {
    name: "websearch",
    title: "网页搜索",
    summary: "搜索网页并返回结果。",
    execution: "inline",
    configuredEnabled: null,
    promptEnabled: true,
    enabled: true,
    available: true,
    effectiveEnabled: true,
    defaultDescription: "Default web search.",
    promptDescription: "Prompt web search.",
    description: "Prompt web search.",
    descriptionSource: "prompt",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索词" } },
      required: ["query"]
    },
    strict: true
  },
  {
    name: "selfie",
    title: "自拍",
    summary: "生成 Bot 自己的形象图。",
    execution: "inline",
    configuredEnabled: null,
    promptEnabled: true,
    enabled: true,
    available: false,
    effectiveEnabled: false,
    availabilityReason: "当前请求未启用自拍生成。",
    defaultDescription: "Default selfie.",
    description: "Default selfie.",
    descriptionSource: "default",
    parameters: { type: "object", properties: {}, required: [] },
    strict: true
  }
];

const directRuntimeTools = [
  {
    name: "workspace_bash",
    title: "Bash",
    summary: "执行 workspace 命令。",
    execution: "inline",
    configuredEnabled: false,
    promptEnabled: true,
    enabled: false,
    available: true,
    effectiveEnabled: false,
    defaultDescription: "Run workspace commands.",
    description: "Run workspace commands.",
    descriptionSource: "default",
    parameters: { type: "object", properties: {}, required: [] },
    strict: true
  },
  {
    name: "codex",
    title: "Codex",
    summary: "执行异步任务。",
    execution: "deferred",
    configuredEnabled: true,
    promptEnabled: true,
    enabled: true,
    available: true,
    effectiveEnabled: true,
    defaultDescription: "Delegate long work.",
    description: "Delegate long work.",
    descriptionSource: "default",
    parameters: { type: "object", properties: {}, required: [] },
    strict: true
  }
];

const noReplyTool = {
  name: "no_reply",
  title: "不回复",
  summary: "结束本轮且不发送文字。",
  execution: "inline",
  configuredEnabled: null,
  promptEnabled: true,
  enabled: true,
  available: true,
  effectiveEnabled: true,
  defaultDescription: "End the turn without a text reply.",
  description: "End the turn without a text reply.",
  descriptionSource: "default",
  parameters: { type: "object", properties: {}, required: [] },
  strict: true
};

describe("ToolCatalogSettings", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ tools });
  });

  it("filters the catalog and keeps configuration separate from capability", async () => {
    const wrapper = mount(ToolCatalogSettings, {
      props: { modelValue: toolsDraft(), bash: bashDraft() },
      global: { stubs: { DialogOverlay: dialogStub() } }
    });
    await flushPromises();

    expect(wrapper.findAll("article")).toHaveLength(2);
    expect(wrapper.text()).toContain("配置已启用");
    expect(wrapper.text()).toContain("能力不可用");
    expect(wrapper.text()).toContain("当前请求未启用自拍生成。");
    const unavailableToggle = wrapper.findAll("label").find((label) => label.text().includes("启用 自拍"));
    expect(unavailableToggle?.find('input[type="checkbox"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('input[aria-label="搜索工具"]').setValue("selfie");
    expect(wrapper.findAll("article")).toHaveLength(1);
    expect(wrapper.text()).toContain("自拍");
    await wrapper.get('input[aria-label="搜索工具"]').setValue("");
    expect(wrapper.findAll("article")).toHaveLength(2);
  });

  it("writes sparse enabled and description overrides and restores inherited text", async () => {
    const draft = toolsDraft();
    const wrapper = mount(ToolCatalogSettings, {
      props: { modelValue: draft, bash: bashDraft() },
      global: { stubs: { DialogOverlay: dialogStub() } }
    });
    await flushPromises();

    const websearchToggle = wrapper.findAll("label").find((label) => label.text().includes("启用 网页搜索"));
    await websearchToggle!.find('input[type="checkbox"]').setValue(false);
    expect(draft.overrides.websearch).toEqual({ enabled: false });

    await wrapper.get('button[aria-label="查看 网页搜索 详情"]').trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("网页搜索");
    await wrapper.get('textarea[maxlength="4000"]').setValue("只在需要实时信息时搜索网页。");
    expect(draft.overrides.websearch).toEqual({
      enabled: false,
      description: "只在需要实时信息时搜索网页。"
    });
    expect(wrapper.get('table[aria-label="工具参数"]').text()).toContain("query");
    expect(wrapper.get('table[aria-label="工具参数"]').text()).toContain("必填");

    const reset = wrapper.findAll("button").find((button) => button.text().includes("恢复继承说明"));
    await reset!.trigger("click");
    expect(draft.overrides.websearch).toEqual({ enabled: false });
    expect((wrapper.get('textarea[maxlength="4000"]').element as HTMLTextAreaElement).value).toBe("Prompt web search.");

    await websearchToggle!.find('input[type="checkbox"]').setValue(true);
    expect(draft.overrides.websearch).toBeUndefined();
  });

  it("uses direct runtime switches for Bash and Codex without enabled overrides", async () => {
    apiRequest.mockResolvedValueOnce({ tools: directRuntimeTools });
    const draft = toolsDraft();
    draft.overrides.codex = { enabled: false, description: "Codex 说明" };
    draft.overrides.workspace_bash = { enabled: true, description: "Bash 说明" };
    const bash = bashDraft();
    const wrapper = mount(ToolCatalogSettings, {
      props: { modelValue: draft, bash },
      global: { stubs: { DialogOverlay: dialogStub() } }
    });
    await flushPromises();

    const bashToggle = wrapper.findAll("label").find((label) => label.text().includes("启用 Bash"));
    const codexToggle = wrapper.findAll("label").find((label) => label.text().includes("启用 Codex"));
    await bashToggle!.get('input[type="checkbox"]').setValue(true);
    await codexToggle!.get('input[type="checkbox"]').setValue(false);

    expect(bash.enabled).toBe(true);
    expect(draft.codex.enabled).toBe(false);
    expect(draft.overrides.workspace_bash).toEqual({ description: "Bash 说明" });
    expect(draft.overrides.codex).toEqual({ description: "Codex 说明" });
  });

  it("edits the shared no_reply poke setting from the tool detail", async () => {
    apiRequest.mockResolvedValueOnce({ tools: [noReplyTool] });
    const updates: boolean[] = [];
    const wrapper = mount(ToolCatalogSettings, {
      props: {
        modelValue: toolsDraft(),
        bash: bashDraft(),
        pokeOnNoReply: false,
        "onUpdate:pokeOnNoReply": (enabled: boolean) => updates.push(enabled)
      },
      global: { stubs: { DialogOverlay: dialogStub() } }
    });
    await flushPromises();

    await wrapper.get('button[aria-label="查看 不回复 详情"]').trigger("click");
    const pokeToggle = wrapper.findAll("label")
      .find((label) => label.text().includes("no_reply 时戳一戳"));
    await pokeToggle!.get('input[type="checkbox"]').setValue(true);

    expect(updates).toEqual([true]);
  });
});

function dialogStub() {
  return {
    props: ["open"],
    template: '<div v-if="open" role="dialog"><slot /></div>'
  };
}
