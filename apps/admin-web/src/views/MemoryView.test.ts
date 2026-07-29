import { flushPromises, shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../types";
import { activeAgentIdState } from "../composables/agentScope";
import DreamHistoryPanel from "../components/memory/DreamHistoryPanel.vue";
import DialogOverlay from "../components/ui/DialogOverlay.vue";
import MemoryEntryRow from "../components/memory/MemoryEntryRow.vue";
import MemoryEditorDialog from "../components/memory/MemoryEditorDialog.vue";
import MemoryInspector from "../components/memory/MemoryInspector.vue";
import MemoryOperationLogDrawer from "../components/memory/MemoryOperationLogDrawer.vue";
import MemoryPagination from "../components/memory/MemoryPagination.vue";
import MemorySortControl from "../components/memory/MemorySortControl.vue";
import MemoryView from "./MemoryView.vue";

const memory = vi.hoisted(() => ({
  sources: { value: [
    { id: "working", title: "工作记忆", fileName: "WORKING_MEMORY.md", editable: true },
    { id: "long_term", title: "长期记忆", fileName: "memory", editable: true },
    { id: "user_profile", title: "用户画像", fileName: "profile", editable: true }
  ] },
  entries: { value: [] as MemoryEntry[] },
  document: { value: {
    fileName: "WORKING_MEMORY.md",
    content: "<!-- sunabot-workmemory:v2 -->\n\n<!-- sunabot-workmemory:item eyJpZCI6Im1lbW9yeS0xIn0 -->\n完整工作记忆正文。",
    revision: "working-revision"
  } },
  matches: { value: [] as MemoryEntry[] },
  recallActive: { value: false },
  loading: { value: false },
  mutating: { value: false },
  error: { value: "" },
  load: vi.fn(),
  recall: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  clearMatches: vi.fn(),
  dispose: vi.fn()
}));
const dreams = vi.hoisted(() => ({
  items: { value: [] },
  timeZone: { value: "Asia/Shanghai" },
  nextScheduledFor: { value: "2026-07-21T04:00:00.000+08:00" },
  loading: { value: false },
  error: { value: "" },
  triggering: { value: false },
  triggerStatus: { value: "" },
  triggerStatusKind: { value: "" },
  load: vi.fn(),
  trigger: vi.fn(),
  dispose: vi.fn()
}));
const operationLogs = vi.hoisted(() => ({
  logs: { value: [] },
  page: { value: 1 },
  pageSize: 50,
  total: { value: 0 },
  pageCount: { value: 1 },
  loading: { value: false },
  error: { value: "" },
  load: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn()
}));

vi.mock("../composables/agentScope", async () => {
  const { shallowRef } = await vi.importActual<typeof import("vue")>("vue");
  return { activeAgentIdState: shallowRef("plana") };
});
vi.mock("../composables/useDreams", () => ({ useDreams: () => dreams }));
vi.mock("../composables/useMemory", () => ({ useMemory: () => memory }));
vi.mock("../composables/useMemoryOperationLogs", () => ({ useMemoryOperationLogs: () => operationLogs }));

function mountMemoryView() {
  return shallowMount(MemoryView);
}

function entry(index: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `memory-${index}`,
    source: "long_term",
    sourceTitle: "长期记忆",
    fileName: "memory",
    editable: true,
    key: `memory-${index}`,
    value: `记忆 ${index}`,
    text: `记忆 ${index}`,
    field: "fact",
    ...overrides
  };
}

describe("MemoryView pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.create.mockResolvedValue(true);
    memory.update.mockResolvedValue(true);
    memory.remove.mockResolvedValue(true);
    (activeAgentIdState as { value: string }).value = "plana";
    memory.entries.value = Array.from({ length: 25 }, (_, index) => entry(index + 1));
  });

  it("opens the selected Agent memory operation log and closes it after Agent switching", async () => {
    const wrapper = mountMemoryView();

    await wrapper.get("button.btn-ghost").trigger("click");

    expect(operationLogs.load).toHaveBeenCalledWith("plana", 1);
    expect(wrapper.findComponent(MemoryOperationLogDrawer).props("open")).toBe(true);

    (activeAgentIdState as { value: string }).value = "arona";
    await nextTick();

    expect(operationLogs.reset).toHaveBeenCalled();
    expect(wrapper.findComponent(MemoryOperationLogDrawer).props("open")).toBe(false);
  });

  it("shows 20 entries per page and resets to page one after filtering", async () => {
    const wrapper = mountMemoryView();
    await wrapper.get('nav[aria-label="记忆类别"]').findAll("button")[1]!.trigger("click");
    const pagination = wrapper.findComponent(MemoryPagination);

    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(20);
    expect(pagination.props()).toMatchObject({ page: 1, pageCount: 2, pageSize: 20, total: 25 });

    pagination.vm.$emit("change", 2);
    await nextTick();
    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(5);
    expect(wrapper.findAllComponents(MemoryEntryRow)[0]?.props("entry").id).toBe("memory-21");

    await wrapper.get('input[aria-label="搜索记忆"]').setValue("记忆 25");
    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(1);
    expect(wrapper.findComponent(MemoryPagination).props()).toMatchObject({ page: 1, pageCount: 1, total: 1 });
  });

  it("sorts before pagination and resets to page one when sorting changes", async () => {
    memory.entries.value = Array.from({ length: 25 }, (_, index) => entry(index + 1, {
      createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
      updatedAt: `2026-07-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`,
      lastRecalledAt: index % 2 === 0
        ? `2026-07-${String(index + 1).padStart(2, "0")}T03:00:00.000Z`
        : undefined
    }));
    const wrapper = mountMemoryView();
    await wrapper.get('nav[aria-label="记忆类别"]').findAll("button")[1]!.trigger("click");
    const sort = wrapper.findComponent(MemorySortControl);

    expect(wrapper.findAllComponents(MemoryEntryRow)[0]?.props("entry").id).toBe("memory-25");
    wrapper.findComponent(MemoryPagination).vm.$emit("change", 2);
    await nextTick();
    expect(wrapper.findComponent(MemoryPagination).props("page")).toBe(2);

    sort.vm.$emit("update:direction", "asc");
    await nextTick();
    expect(wrapper.findComponent(MemoryPagination).props("page")).toBe(1);
    expect(wrapper.findAllComponents(MemoryEntryRow)[0]?.props("entry").id).toBe("memory-1");

    sort.vm.$emit("update:field", "lastRecalledAt");
    sort.vm.$emit("update:direction", "desc");
    await nextTick();
    expect(wrapper.findAllComponents(MemoryEntryRow).slice(0, 3).map((row) => row.props("entry").id)).toEqual([
      "memory-25", "memory-23", "memory-21"
    ]);
  });

  it("shows dreams as a peer tab without sending dream to the memory API", async () => {
    const wrapper = shallowMount(MemoryView);
    const tabs = wrapper.get('nav[aria-label="记忆类别"]');

    expect(tabs.findAll("button").map((button) => button.text())).toEqual(expect.arrayContaining([
      expect.stringContaining("工作记忆"),
      expect.stringContaining("长期记忆"),
      expect.stringContaining("用户画像"),
      expect.stringContaining("场域知识"),
      expect.stringContaining("梦境")
    ]));
    await tabs.findAll("button")[4]!.trigger("click");

    expect(wrapper.findComponent(DreamHistoryPanel).props()).toMatchObject({
      timeZone: "Asia/Shanghai",
      nextScheduledFor: "2026-07-21T04:00:00.000+08:00",
      sortField: "updatedAt",
      sortDirection: "desc"
    });
    expect(wrapper.findComponent(MemorySortControl).exists()).toBe(false);
    expect(wrapper.find('input[aria-label="搜索记忆"]').exists()).toBe(false);
    expect(wrapper.findComponent(MemoryPagination).exists()).toBe(false);
    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(0);
    expect(wrapper.findComponent(MemoryEditorDialog).exists()).toBe(false);
    expect(memory.load.mock.calls.some(([requestedSource]) => requestedSource === "dream")).toBe(false);
    wrapper.findComponent(DreamHistoryPanel).vm.$emit("trigger");
    await nextTick();
    expect(dreams.trigger).toHaveBeenCalledWith("plana");

    await tabs.findAll("button")[0]!.trigger("click");

    expect(wrapper.get('[aria-label="工作记忆原文"]').text()).toContain("完整工作记忆正文。");
    expect(wrapper.get('[aria-label="工作记忆原文"]').text()).not.toContain("sunabot-workmemory");
    expect(wrapper.find('input[aria-label="搜索记忆"]').exists()).toBe(false);
    expect(wrapper.findComponent(MemoryPagination).exists()).toBe(false);
    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(0);

    await tabs.findAll("button")[1]!.trigger("click");
    expect(memory.load).toHaveBeenLastCalledWith("long_term", "plana");
    expect(memory.load.mock.calls.some(([requestedSource]) => requestedSource === "dream")).toBe(false);
  });

  it("reloads both sections and clears transient actions when Agent changes", async () => {
    const wrapper = shallowMount(MemoryView);
    await wrapper.get('nav[aria-label="记忆类别"]').findAll("button")[1]!.trigger("click");
    const firstRow = wrapper.findAllComponents(MemoryEntryRow)[0]!;
    const editor = wrapper.findComponent(MemoryEditorDialog);

    expect(memory.load).toHaveBeenCalledWith("long_term", "plana");
    expect(dreams.load).toHaveBeenCalledWith("plana");
    expect(wrapper.findComponent(DreamHistoryPanel).exists()).toBe(false);

    await wrapper.findAll("button").find((button) => button.text().includes("新增"))!.trigger("click");
    await nextTick();
    expect(editor.props("open")).toBe(true);
    expect(editor.props("source")).toBe("long_term");
    editor.vm.$emit("save", { source: "long_term", text: "新记忆" });
    await flushPromises();
    expect(memory.create).toHaveBeenCalledWith({ source: "long_term", text: "新记忆" }, "plana");
    expect(wrapper.text()).toContain("已保存");

    firstRow.vm.$emit("select", entry(1));
    await nextTick();
    const inspector = wrapper.findComponent(MemoryInspector);
    inspector.vm.$emit("remove", entry(1));
    await nextTick();
    expect(inspector.props("pendingDelete")).toBe(true);

    (activeAgentIdState as { value: string }).value = "arona";
    await nextTick();

    expect(memory.load).toHaveBeenLastCalledWith("long_term", "arona");
    expect(dreams.load).toHaveBeenLastCalledWith("arona");
    expect(editor.props("open")).toBe(false);
    expect(wrapper.findComponent(MemoryInspector).exists()).toBe(false);
    expect(wrapper.text()).not.toContain("已保存");

    wrapper.unmount();
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(dreams.dispose).toHaveBeenCalledOnce();
  });

  it("locks new entries to the active editable source", async () => {
    const wrapper = mountMemoryView();
    const tabs = wrapper.get('nav[aria-label="记忆类别"]');

    await tabs.findAll("button")[2]!.trigger("click");
    await wrapper.findAll("button").find((button) => button.text().includes("新增"))!.trigger("click");

    expect(wrapper.findComponent(MemoryEditorDialog).props()).toMatchObject({
      open: true,
      source: "user_profile"
    });
  });

  it("supports roving keyboard focus across memory tabs", async () => {
    const wrapper = shallowMount(MemoryView, { attachTo: document.body });
    const tabs = wrapper.get('nav[aria-label="记忆类别"]').findAll('[role="tab"]');

    expect(tabs.map((tab) => tab.attributes("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1"]);
    await tabs[0]!.trigger("keydown", { key: "End" });
    await nextTick();

    expect(tabs[4]!.attributes("aria-selected")).toBe("true");
    expect(tabs.map((tab) => tab.attributes("tabindex"))).toEqual(["-1", "-1", "-1", "-1", "0"]);

    await tabs[4]!.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    expect(tabs[0]!.attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("does not hijack the search shortcut from editors or open dialogs", async () => {
    const wrapper = shallowMount(MemoryView, { attachTo: document.body });
    await wrapper.get('nav[aria-label="记忆类别"]').findAll("button")[1]!.trigger("click");
    const search = wrapper.get<HTMLInputElement>('input[aria-label="搜索记忆"]');
    const focus = vi.spyOn(search.element, "focus");
    const textarea = document.createElement("textarea");
    document.body.append(textarea);

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(focus).not.toHaveBeenCalled();

    await wrapper.findAll("button").find((button) => button.text().includes("新增"))!.trigger("click");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    expect(focus).not.toHaveBeenCalled();

    textarea.remove();
    wrapper.unmount();
  });

  it("closes the mobile inspector when the viewport crosses into the desktop layout", async () => {
    let desktopChange: ((event: MediaQueryListEvent) => void) | undefined;
    const desktopQuery = {
      matches: false,
      media: "(min-width: 1280px)",
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") {
          desktopChange = listener as (event: MediaQueryListEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    } as unknown as MediaQueryList;
    const mobileQuery = {
      ...desktopQuery,
      matches: true,
      media: "(max-width: 1279px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } satisfies MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn((query: string) =>
      query === "(min-width: 1280px)" ? desktopQuery : mobileQuery));
    const wrapper = mountMemoryView();
    await wrapper.get('nav[aria-label="记忆类别"]').findAll("button")[1]!.trigger("click");
    wrapper.findAllComponents(MemoryEntryRow)[0]!.vm.$emit("select", entry(1));
    await nextTick();

    expect(wrapper.findComponent(DialogOverlay).props("open")).toBe(true);

    desktopChange?.({ matches: true } as MediaQueryListEvent);
    await nextTick();

    expect(wrapper.findComponent(DialogOverlay).props("open")).toBe(false);
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it("does not show an unrequested selected row in the mobile list", async () => {
    const mobileQuery = {
      matches: false,
      media: "(min-width: 1280px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => mobileQuery));
    const wrapper = mountMemoryView();

    await wrapper.get('nav[aria-label="记忆类别"]').findAll("button")[1]!.trigger("click");
    await nextTick();

    expect(wrapper.findAllComponents(MemoryEntryRow)[0]!.props("selected")).toBe(false);
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it("explains that the first profile address name has priority", () => {
    const wrapper = shallowMount(MemoryEditorDialog, {
      props: {
        open: true,
        entry: entry(10, {
          source: "user_profile",
          sourceTitle: "用户画像",
          userId: "10001",
          addressNames: ["猫老师", "老师"]
        }),
        source: "user_profile",
        busy: false,
        error: ""
      }
    });

    expect(wrapper.get('input[aria-label="称呼"]').attributes("placeholder")).toContain("第一个");
  });

  it("gives each memory row a distinct accessible name", () => {
    const wrapper = shallowMount(MemoryEntryRow, {
      props: {
        entry: entry(7, { text: "用户偏爱夜间整理信息" }),
        selected: false
      }
    });

    expect(wrapper.get("button").attributes("aria-label")).toContain("用户偏爱夜间整理信息");
    expect(wrapper.get("button").attributes("aria-label")).toContain("memory-7");
  });

  it("keeps memory summaries clamped without overriding the clamp display mode", () => {
    const longTerm = shallowMount(MemoryEntryRow, {
      props: { entry: entry(8, { text: "很长的长期记忆正文" }), selected: false }
    });
    const profile = shallowMount(MemoryEntryRow, {
      props: {
        entry: entry(9, {
          source: "user_profile",
          sourceTitle: "用户画像",
          userId: "171419991",
          userNickname: "猫老师",
          text: "很长的用户画像正文"
        }),
        selected: false
      }
    });

    const longSummary = longTerm.get(".line-clamp-3");
    const profileSummary = profile.get(".line-clamp-2");
    expect(longSummary.classes()).not.toContain("block");
    expect(profileSummary.classes()).not.toContain("block");
  });
});
