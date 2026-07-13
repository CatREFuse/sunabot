import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentAvatarInput, AgentSummary } from "../../types";
import AgentAvatarPicker from "../agents/AgentAvatarPicker.vue";
import IdentityAvatar from "../ui/IdentityAvatar.vue";
import AgentAvatarField from "./AgentAvatarField.vue";

const agent: AgentSummary = {
  id: "plana",
  name: "普拉娜",
  enabled: true,
  workspace: "workspace/business/agents/plana",
  avatarPath: "assets/avatar-version.png",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-13T08:00:00.000Z",
  accounts: []
};

describe("AgentAvatarField", () => {
  it("shows a circular preview and forwards the cropped avatar", async () => {
    const wrapper = mount(AgentAvatarField, {
      props: { agent },
      global: { stubs: { AgentAvatarPicker: true } }
    });
    const avatar: AgentAvatarInput = { fileName: "avatar.png", dataBase64: "data:image/png;base64,cropped" };

    expect(wrapper.getComponent(IdentityAvatar).props("src")).toBe(
      "/api/agents/plana/avatar?v=assets%2Favatar-version.png"
    );
    expect(wrapper.text()).toContain("PNG、JPEG 或 WebP");
    expect(wrapper.text()).not.toContain("MiB");
    wrapper.getComponent(AgentAvatarPicker).vm.$emit("change", avatar);
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("upload")?.[0]).toEqual([avatar]);
  });
});
