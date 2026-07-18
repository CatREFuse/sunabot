import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MonitoringSettingsForm from "./MonitoringSettingsForm.vue";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

const settings = {
  barkConfigured: false,
  aggregationWindowSeconds: 60,
  onebotOfflineGraceSeconds: 20,
  heartbeatStaleSeconds: 120,
  serverEventsEnabled: true,
  onebotEventsEnabled: true
};

describe("MonitoringSettingsForm", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("saves a monitoring field from its local confirm button", async () => {
    apiRequest
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ ...settings, aggregationWindowSeconds: 90 });
    const wrapper = mount(MonitoringSettingsForm);
    await flushPromises();

    await wrapper.findAll('input[type="number"]')[0]!.setValue("90");
    expect(apiRequest).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-confirm-label="确认聚合窗口"]').trigger("click");
    await flushPromises();

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body))).toMatchObject({ aggregationWindowSeconds: 90 });
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("保存监控设置");
    expect(wrapper.text()).not.toContain("已同步");
    wrapper.unmount();
  });

  it("keeps the current input and inline error when saving fails", async () => {
    apiRequest.mockResolvedValueOnce(settings).mockRejectedValueOnce(new Error("监控设置无效"));
    const wrapper = mount(MonitoringSettingsForm);
    await flushPromises();
    const input = wrapper.findAll('input[type="number"]')[0]!;

    await input.setValue("91");
    await wrapper.get('[data-confirm-label="确认聚合窗口"]').trigger("click");
    await flushPromises();

    expect((input.element as HTMLInputElement).value).toBe("91");
    expect(wrapper.text()).toContain("监控设置无效");
    wrapper.unmount();
  });
});
