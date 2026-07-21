import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { MemoryEntry, MemorySource } from "../../types";
import MemoryEditorDialog from "./MemoryEditorDialog.vue";

const sources: MemorySource[] = [
  { id: "working", title: "工作记忆", fileName: "WORKING_MEMORY.jsonl", editable: true },
  { id: "long_term", title: "长期记忆", fileName: "LONG_TERM_MEMORY.jsonl", editable: true },
  { id: "user_profile", title: "用户画像", fileName: "USER_PROFILE.jsonl", editable: true }
];

const profile: MemoryEntry = {
  id: "profile-1",
  source: "user_profile",
  sourceTitle: "用户画像",
  fileName: "USER_PROFILE.jsonl",
  editable: true,
  key: "QQ 171419991",
  value: "偏好紧凑的界面。",
  text: "偏好紧凑的界面。",
  field: "fact",
  userId: "171419991",
  userName: "当前昵称",
  addressNames: ["猫老师", "老师"]
};

describe("MemoryEditorDialog", () => {
  it("keeps the salutation when only the profile body changes", async () => {
    const wrapper = mount(MemoryEditorDialog, {
      props: { open: true, entry: profile, sources, busy: false, error: "" },
      global: { stubs: { DialogOverlay: { template: "<div><slot /></div>" } } }
    });

    expect(wrapper.text()).not.toContain("MEMORY ENTRY");
    expect(wrapper.get('input[autocomplete="off"]').element).toHaveProperty("value", "猫老师、老师");
    expect(wrapper.get('input[inputmode="numeric"]').attributes()).toHaveProperty("disabled");
    await wrapper.get("textarea").setValue("正文已经更新。");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("save")?.[0]?.[0]).toEqual({
      source: "user_profile",
      id: "profile-1",
      text: "正文已经更新。",
      addressNames: ["猫老师", "老师"]
    });
  });
});
