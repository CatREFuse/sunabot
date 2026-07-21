import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MemorySortControl from "./MemorySortControl.vue";

describe("MemorySortControl", () => {
  it("offers all time fields and emits field and direction changes", async () => {
    const wrapper = mount(MemorySortControl, {
      props: { field: "updatedAt", direction: "desc" }
    });

    expect(wrapper.get('select[aria-label="排序字段"]').findAll("option").map((option) => option.text())).toEqual([
      "添加时间", "更新时间", "召回时间"
    ]);
    expect(wrapper.get('select[aria-label="排序方向"]').findAll("option").map((option) => option.text())).toEqual([
      "逆序（新到旧）", "正序（旧到新）"
    ]);

    await wrapper.get('select[aria-label="排序字段"]').setValue("lastRecalledAt");
    await wrapper.get('select[aria-label="排序方向"]').setValue("asc");
    expect(wrapper.emitted("update:field")).toEqual([["lastRecalledAt"]]);
    expect(wrapper.emitted("update:direction")).toEqual([["asc"]]);
  });
});
