import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAgentId } from "../../composables/agentScope";
import SelfieReferenceManager from "./SelfieReferenceManager.vue";
import SelfieReferenceSettings from "./SelfieReferenceSettings.vue";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

describe("SelfieReferenceSettings", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ images: [], maxImages: 9 });
    setActiveAgentId("plana");
  });

  afterEach(() => {
    setActiveAgentId("plana");
  });

  it("renders one inline manager and reloads it when the active Agent changes", async () => {
    const wrapper = shallowMount(SelfieReferenceSettings);
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/selfie-references?agentId=plana");
    expect(wrapper.findComponent(SelfieReferenceManager).exists()).toBe(true);
    expect(wrapper.find('button[aria-label="管理自拍参考图"]').exists()).toBe(false);
    const initialManager = wrapper.getComponent(SelfieReferenceManager).vm;

    setActiveAgentId("arona");
    await nextTick();

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/selfie-references?agentId=arona");
    expect(wrapper.getComponent(SelfieReferenceManager).vm).not.toBe(initialManager);
    wrapper.unmount();
  });
});
