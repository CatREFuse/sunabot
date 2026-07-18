import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAgentId } from "../../composables/agentScope";
import SelfieReferenceDialog from "./SelfieReferenceDialog.vue";
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

  it("reloads immediately and closes the manager when the active Agent changes", async () => {
    const wrapper = shallowMount(SelfieReferenceSettings);
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/selfie-references?agentId=plana");

    await wrapper.get('button[aria-label="管理自拍参考图"]').trigger("click");
    expect(wrapper.getComponent(SelfieReferenceDialog).props("open")).toBe(true);

    setActiveAgentId("arona");
    await nextTick();

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/selfie-references?agentId=arona");
    expect(wrapper.getComponent(SelfieReferenceDialog).props("open")).toBe(false);
    wrapper.unmount();
  });
});
