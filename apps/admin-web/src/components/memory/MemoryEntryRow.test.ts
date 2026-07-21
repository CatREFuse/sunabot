import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../../types";
import MemoryEntryRow from "./MemoryEntryRow.vue";

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "memory-1",
    source: "working",
    sourceTitle: "工作记忆",
    fileName: "WORKING_MEMORY.jsonl",
    editable: true,
    key: "memory-1",
    value: "记忆正文",
    text: "记忆正文",
    field: "fact",
    ...overrides
  };
}

describe("MemoryEntryRow", () => {
  it("shows the nickname, persisted salutation, group cards and QQ separately", () => {
    const wrapper = shallowMount(MemoryEntryRow, {
      props: {
        entry: entry({
          source: "user_profile",
          sourceTitle: "用户画像",
          fileName: "USER_PROFILE.jsonl",
          userId: "171419991",
          userName: "最后观测昵称",
          userNickname: "当前 QQ 昵称",
          addressNames: ["猫老师", "老师"],
          groupCards: [{ groupId: 10001, card: "群内名片", lastSeenAt: "2026-07-10T02:00:00.000Z" }]
        }),
        pendingDelete: false
      }
    });

    expect(wrapper.text()).toContain("QQ 昵称 当前 QQ 昵称");
    expect(wrapper.text()).toContain("称呼 猫老师、老师");
    expect(wrapper.text()).toContain("群名片 群内名片 · 群 10001");
    expect(wrapper.text()).toContain("QQ 171419991");
  });

  it("shows an event range and preserves an unparseable legacy time", () => {
    const range = shallowMount(MemoryEntryRow, {
      props: {
        entry: entry({
          occurredAt: "2026-07-10T02:00:00.000Z",
          occurredEndAt: "2026-07-10T03:00:00.000Z",
          updatedAt: "2026-07-10T03:01:00.000Z"
        }),
        pendingDelete: false
      }
    });
    const legacy = shallowMount(MemoryEntryRow, {
      props: { entry: entry({ legacyTime: "2026-07-01/2026-07-02" }), pendingDelete: false }
    });

    expect(range.text()).toContain("发生");
    expect(range.text()).toContain("至");
    expect(range.text()).toContain("更新");
    expect(range.text()).not.toContain("fact");
    expect(range.text()).not.toContain("--");
    expect(legacy.text()).toContain("发生 2026-07-01/2026-07-02");
  });

  it("shows long-term recall frequency and distinct recall days", () => {
    const wrapper = shallowMount(MemoryEntryRow, {
      props: {
        entry: entry({
          source: "long_term",
          sourceTitle: "长期记忆",
          fileName: "LONG_TERM_MEMORY.jsonl",
          recallCount: 4,
          distinctRecallDays: 3,
          lastRecalledAt: "2026-07-20T03:00:00.000Z"
        }),
        pendingDelete: false
      }
    });

    expect(wrapper.text()).toContain("召回 4 次");
    expect(wrapper.text()).toContain("跨 3 天");
    expect(wrapper.text()).toContain("最近召回");
  });
});
