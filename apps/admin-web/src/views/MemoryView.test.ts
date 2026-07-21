import { flushPromises, shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../types";
import { activeAgentIdState } from "../composables/agentScope";
import DreamHistoryPanel from "../components/memory/DreamHistoryPanel.vue";
import MemoryEntryRow from "../components/memory/MemoryEntryRow.vue";
import MemoryEditorDialog from "../components/memory/MemoryEditorDialog.vue";
import MemoryPagination from "../components/memory/MemoryPagination.vue";
import MemorySortControl from "../components/memory/MemorySortControl.vue";
import MemoryView from "./MemoryView.vue";

const memory = vi.hoisted(() => ({
  sources: { value: [
    { id: "working", title: "工作记忆", fileName: "memory", editable: true },
    { id: "longterm", title: "长期记忆", fileName: "memory", editable: true },
    { id: "user_profile", title: "用户画像", fileName: "profile", editable: true }
  ] },
  entries: { value: [] as MemoryEntry[] },
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

vi.mock("../composables/agentScope", async () => {
  const { shallowRef } = await vi.importActual<typeof import("vue")>("vue");
  return { activeAgentIdState: shallowRef("plana") };
});
vi.mock("../composables/useDreams", () => ({ useDreams: () => dreams }));
vi.mock("../composables/useMemory", () => ({ useMemory: () => memory }));

function entry(index: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `memory-${index}`,
    source: "working",
    sourceTitle: "工作记忆",
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
    (activeAgentIdState as { value: string }).value = "plana";
    memory.entries.value = Array.from({ length: 25 }, (_, index) => entry(index + 1));
  });

  it("shows 20 entries per page and resets to page one after filtering", async () => {
    const wrapper = shallowMount(MemoryView);
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
    const wrapper = shallowMount(MemoryView);
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
    const wrapper = shallowMount(MemoryView, {
      global: {
        stubs: {
          PageHeader: { template: '<header><slot name="titleAfter"/><slot name="actions"/></header>' }
        }
      }
    });
    const tabs = wrapper.get('nav[aria-label="记忆类别"]');

    expect(tabs.findAll("button").map((button) => button.text())).toEqual([
      "工作记忆",
      "长期记忆",
      "用户画像",
      "梦境"
    ]);
    wrapper.findComponent(MemoryPagination).vm.$emit("change", 2);
    await nextTick();
    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(5);

    await tabs.findAll("button")[3]!.trigger("click");

    expect(wrapper.findComponent(DreamHistoryPanel).props()).toMatchObject({
      timeZone: "Asia/Shanghai",
      nextScheduledFor: "2026-07-21T04:00:00.000+08:00",
      sortField: "updatedAt",
      sortDirection: "desc"
    });
    expect(wrapper.findComponent(MemorySortControl).exists()).toBe(true);
    expect(wrapper.find('input[aria-label="搜索记忆"]').exists()).toBe(false);
    expect(wrapper.findComponent(MemoryPagination).exists()).toBe(false);
    expect(wrapper.findAllComponents(MemoryEntryRow)).toHaveLength(0);
    expect(wrapper.findComponent(MemoryEditorDialog).exists()).toBe(false);
    expect(memory.load.mock.calls.some(([requestedSource]) => requestedSource === "dream")).toBe(false);
    wrapper.findComponent(DreamHistoryPanel).vm.$emit("trigger");
    await nextTick();
    expect(dreams.trigger).toHaveBeenCalledWith("plana");

    await tabs.findAll("button")[0]!.trigger("click");

    expect(wrapper.find('input[aria-label="搜索记忆"]').exists()).toBe(true);
    expect(wrapper.findComponent(MemoryPagination).props("page")).toBe(2);
    expect(wrapper.findAllComponents(MemoryEntryRow)[0]?.props("entry").id).toBe("memory-21");

    await tabs.findAll("button")[1]!.trigger("click");
    expect(memory.load).toHaveBeenLastCalledWith("longterm", "plana");
    expect(memory.load.mock.calls.some(([requestedSource]) => requestedSource === "dream")).toBe(false);
  });

  it("reloads both sections and clears transient actions when Agent changes", async () => {
    const wrapper = shallowMount(MemoryView, {
      global: {
        stubs: {
          PageHeader: { template: '<header><slot name="titleAfter"/><slot name="actions"/></header>' }
        }
      }
    });
    const firstRow = wrapper.findAllComponents(MemoryEntryRow)[0]!;
    const editor = wrapper.findComponent(MemoryEditorDialog);

    expect(memory.load).toHaveBeenCalledWith("working", "plana");
    expect(dreams.load).toHaveBeenCalledWith("plana");
    expect(wrapper.findComponent(DreamHistoryPanel).exists()).toBe(false);

    firstRow.vm.$emit("edit", entry(1));
    await nextTick();
    expect(editor.props("open")).toBe(true);
    editor.vm.$emit("save", { source: "working", text: "新记忆" });
    await flushPromises();
    expect(wrapper.text()).toContain("已保存");

    firstRow.vm.$emit("edit", entry(1));
    firstRow.vm.$emit("remove", entry(1));
    await nextTick();
    expect(editor.props("open")).toBe(true);
    expect(firstRow.props("pendingDelete")).toBe(true);

    (activeAgentIdState as { value: string }).value = "arona";
    await nextTick();

    expect(memory.load).toHaveBeenLastCalledWith("working", "arona");
    expect(dreams.load).toHaveBeenLastCalledWith("arona");
    expect(editor.props("open")).toBe(false);
    expect(firstRow.props("pendingDelete")).toBe(false);
    expect(wrapper.text()).not.toContain("已保存");

    wrapper.unmount();
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(dreams.dispose).toHaveBeenCalledOnce();
  });
});
