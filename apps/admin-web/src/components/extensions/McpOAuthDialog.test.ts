import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentMcpHttpServer } from "../../types/agentExtensions";
import McpOAuthDialog from "./McpOAuthDialog.vue";

describe("McpOAuthDialog", () => {
  it("shows the bound identity without exposing the credential reference", () => {
    const wrapper = mount(McpOAuthDialog, {
      props: {
        server: connectedServer,
        agentId: "plana",
        agentName: "普拉娜",
        authorizationOrigin: "https://auth.example.test",
        busy: false,
        error: ""
      },
      global: { stubs: { Teleport: true, Transition: false } }
    });

    const target = wrapper.get('[aria-label="OAuth 授权目标"]');
    expect(target.text()).toContain("普拉娜");
    expect(target.text()).toContain("plana");
    expect(target.text()).toContain("remote-search");
    expect(target.text()).toContain("https://mcp.example.test/v1");
    expect(target.text()).toContain("https://auth.example.test");
    expect(wrapper.text()).toContain("已连接");
    expect(wrapper.text()).not.toContain("mcpcred_private-value");
  });

  it("keeps the body scrollable and the action area outside the scroll region", () => {
    const wrapper = mount(McpOAuthDialog, {
      props: {
        server: pendingServer,
        agentId: "plana",
        agentName: "普拉娜",
        authorizationOrigin: "",
        busy: false,
        error: "浏览器拦截了授权窗口，请允许弹出窗口后重试。"
      },
      global: { stubs: { Teleport: true, Transition: false } }
    });

    expect(wrapper.get("form").classes()).toContain("max-h-[calc(100dvh-2rem)]");
    expect(wrapper.get('[data-slot="dialog-scroll"]').classes()).toContain("overflow-y-auto");
    expect(wrapper.get('[data-slot="dialog-actions"]').classes()).toContain("shrink-0");
    expect(wrapper.get('[role="alert"]').text()).toContain("浏览器拦截了授权窗口");
    expect(wrapper.get('[data-slot="dialog-actions"]').text()).toContain("打开授权");
  });
});

const pendingServer: AgentMcpHttpServer = {
  id: "remote-search",
  name: "Remote Search",
  description: "远程搜索服务。",
  enabled: true,
  transport: "streamable_http",
  url: "https://mcp.example.test/v1",
  auth: { kind: "oauth", credentialRef: "pending" }
};

const connectedServer: AgentMcpHttpServer = {
  ...pendingServer,
  auth: { kind: "oauth", credentialRef: "mcpcred_private-value" }
};
