import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VoiceProfileSettings from "../components/voice/VoiceProfileSettings.vue";
import VoiceServiceControls from "../components/voice/VoiceServiceControls.vue";
import { setActiveAgentId } from "../composables/agentScope";
import VoiceView from "./VoiceView.vue";

const voice = vi.hoisted(() => ({
  profile: { value: null },
  provider: { value: null },
  loading: { value: false },
  saving: { value: false },
  serviceAction: { value: "" },
  busyLanguage: { value: "" },
  error: { value: "" },
  message: { value: "" },
  serviceError: { value: "" },
  serviceMessage: { value: "" },
  load: vi.fn(),
  saveSettings: vi.fn(),
  putReference: vi.fn(),
  deleteReference: vi.fn(),
  checkService: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../composables/useVoiceProfile", () => ({
  useVoiceProfile: () => voice,
}));

describe("VoiceView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveAgentId("plana");
  });

  it("loads the current Agent, reloads after a switch, and disposes on unmount", async () => {
    const wrapper = shallowMount(VoiceView);
    expect(voice.load).toHaveBeenCalledWith("plana");
    const firstSettingsUid =
      wrapper.findComponent(VoiceProfileSettings).vm.$.uid;

    setActiveAgentId("arona");
    await nextTick();
    expect(voice.load).toHaveBeenLastCalledWith("arona");
    expect(wrapper.findComponent(VoiceProfileSettings).vm.$.uid).not.toBe(
      firstSettingsUid,
    );

    wrapper.unmount();
    expect(voice.dispose).toHaveBeenCalledOnce();
  });

  it("passes component events to the Agent-scoped composable actions", async () => {
    const wrapper = shallowMount(VoiceView);
    const settings = wrapper.findComponent(VoiceProfileSettings);
    const service = wrapper.findComponent(VoiceServiceControls);
    const file = new File(["wav"], "arona.wav", { type: "audio/wav" });

    settings.vm.$emit("saveSettings", { enabled: true, defaultLanguage: "ja" });
    service.vm.$emit("check");
    service.vm.$emit("start");
    service.vm.$emit("stop");
    settings.vm.$emit("putReference", {
      language: "ja",
      file,
      referenceText: "先生、おはよう！",
    });
    settings.vm.$emit("deleteReference", "ja");
    await nextTick();

    expect(voice.saveSettings).toHaveBeenCalledWith("plana", {
      enabled: true,
      defaultLanguage: "ja",
    });
    expect(voice.checkService).toHaveBeenCalledWith("plana");
    expect(voice.startService).toHaveBeenCalledWith("plana");
    expect(voice.stopService).toHaveBeenCalledWith("plana");
    expect(voice.putReference).toHaveBeenCalledWith("plana", "ja", {
      file,
      referenceText: "先生、おはよう！",
    });
    expect(voice.deleteReference).toHaveBeenCalledWith("plana", "ja");
  });
});
