import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesktopNavigation from "./DesktopNavigation.vue";
import MobileNavigation from "./MobileNavigation.vue";

const theme = vi.hoisted(() => ({ preference: { value: "system" }, setTheme: vi.fn() }));

vi.mock("../../composables/useTheme", () => ({ useTheme: () => theme }));
vi.mock("../../composables/useRuntimeStatus", () => ({
  useRuntimeStatus: () => ({ status: { value: null } })
}));

function router() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }]
  });
}

describe("navigation theme controls", () => {
  beforeEach(() => { theme.setTheme.mockReset(); });

  it("keeps Web Chat visible in desktop and mobile navigation", async () => {
    const navigation = router();
    await navigation.push("/overview");
    const desktop = mount(DesktopNavigation, { global: { plugins: [navigation] } });
    const mobile = mount(MobileNavigation, { global: { plugins: [navigation] } });

    expect(desktop.get('a[href="/web-chat"]').text()).toContain("Web Chat");
    expect(mobile.get('a[href="/web-chat"]').text()).toContain("Web Chat");
  });

  it("offers light, dark and system themes in the mobile More panel", async () => {
    const navigation = router();
    await navigation.push("/overview");
    const wrapper = mount(MobileNavigation, { global: { plugins: [navigation] } });
    const more = wrapper.findAll("button").find((button) => button.text().includes("更多"));
    expect(more).toBeDefined();
    await more!.trigger("click");

    const themeButtons = wrapper.findAll('div[aria-label="主题"] button');
    expect(themeButtons.map((button) => button.text().trim())).toEqual(["浅色", "深色", "系统"]);
    expect(themeButtons[2]!.attributes("aria-pressed")).toBe("true");
    await themeButtons[1]!.trigger("click");
    expect(theme.setTheme).toHaveBeenCalledWith("dark");
  });

  it("keeps every desktop theme control at least 44px high", async () => {
    const navigation = router();
    await navigation.push("/overview");
    const wrapper = mount(DesktopNavigation, { global: { plugins: [navigation] } });
    const themeButtons = wrapper.findAll('div[aria-label="主题"] button');
    expect(themeButtons).toHaveLength(3);
    themeButtons.forEach((button) => expect(button.classes()).toContain("min-h-11"));
    expect(themeButtons.every((button) => !button.classes().some((className) => className.startsWith("rounded")))).toBe(true);
  });
});
