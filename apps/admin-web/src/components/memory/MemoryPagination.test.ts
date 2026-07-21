import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MemoryPagination from "./MemoryPagination.vue";

describe("MemoryPagination", () => {
  it("shows the page range and emits bounded previous and next pages", async () => {
    const wrapper = mount(MemoryPagination, {
      props: { page: 2, pageCount: 3, pageSize: 20, total: 45 }
    });

    expect(wrapper.text()).toContain("共 45 条 · 每页 20 条");
    expect(wrapper.text()).toContain("2 / 3");

    await wrapper.get("button:first-of-type").trigger("click");
    await wrapper.get("button:last-of-type").trigger("click");
    expect(wrapper.emitted("change")).toEqual([[1], [3]]);
  });

  it("disables unavailable directions and stays hidden for one page", () => {
    const first = mount(MemoryPagination, {
      props: { page: 1, pageCount: 2, pageSize: 20, total: 21 }
    });
    const single = mount(MemoryPagination, {
      props: { page: 1, pageCount: 1, pageSize: 20, total: 20 }
    });

    expect(first.get("button:first-of-type").attributes("disabled")).toBeDefined();
    expect(first.get("button:last-of-type").attributes("disabled")).toBeUndefined();
    expect(single.find("nav").exists()).toBe(false);
  });
});
