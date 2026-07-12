import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CodexSubscriptionAuth from "./CodexSubscriptionAuth.vue";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

describe("CodexSubscriptionAuth", () => {
  it("shows the device authorization code returned by Codex CLI", async () => {
    apiRequest.mockResolvedValue({
      installed: true,
      authenticated: false,
      login: {
        state: "waiting",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "AB12-CD34",
        message: "请在设备授权页面完成登录。"
      }
    });
    const wrapper = mount(CodexSubscriptionAuth);
    await flushPromises();
    expect(wrapper.text()).toContain("授权码");
    expect(wrapper.text()).toContain("AB12-CD34");
    expect(wrapper.get("a").attributes("href")).toBe("https://auth.openai.com/codex/device");
    wrapper.unmount();
  });
});
