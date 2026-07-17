import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentMcpServer } from "../../types/agentExtensions";
import McpServerList from "./McpServerList.vue";

const configuredKey = `SUNABOT_MCP_STDIO_SECRET_${"A".repeat(32)}`;
const missingKey = `SUNABOT_MCP_HTTP_BEARER_${"B".repeat(32)}`;

const servers: AgentMcpServer[] = [
  {
    id: "local-search",
    name: "Local Search",
    description: "Local index",
    enabled: false,
    required: false,
    enabledTools: [],
    disabledTools: [],
    approvalMode: "always",
    transport: "stdio",
    command: "/usr/bin/local-search",
    args: [],
    envKeys: ["INDEX_TOKEN"]
  },
  {
    id: "remote-search",
    name: "Remote Search",
    description: "Remote index",
    enabled: false,
    required: false,
    enabledTools: ["search"],
    disabledTools: [],
    approvalMode: "always",
    transport: "streamable_http",
    url: "https://mcp.example.test/v1",
    auth: { kind: "bearer", credentialRef: "mcp/remote-token" }
  }
];

describe("McpServerList", () => {
  it("shows deny-all and only descriptor-proven credential requirements per server", () => {
    const wrapper = mount(McpServerList, {
      props: { servers, statuses: [], busy: false }
    });

    expect(wrapper.text()).toContain("工具 无可用项");
    expect(wrapper.text()).toContain("工具 1 项");
    expect(wrapper.text()).toContain("凭据 环境变量 1 项");
    expect(wrapper.text()).toContain("凭据 Bearer 凭据");
    expect(wrapper.text()).not.toContain("工具 全部");
    expect(wrapper.text()).not.toContain("mcp/remote-token");
  });

  it("lists bounded derived environment names with missing taking precedence", () => {
    const wrapper = mount(McpServerList, {
      props: {
        servers,
        statuses: [],
        busy: false,
        secrets: {
          configuredKeys: [configuredKey, missingKey, "UNSAFE_SECRET_VALUE"],
          missingKeys: [missingKey]
        }
      }
    });

    const rows = wrapper.findAll('[aria-labelledby="mcp-secret-status-title"] li');
    expect(rows).toHaveLength(2);
    const configured = rows.find((row) => row.text().includes(configuredKey));
    const missing = rows.find((row) => row.text().includes(missingKey));
    expect(configured?.text()).toContain("已配置");
    expect(missing?.text()).toContain("缺失");
    expect(wrapper.text()).not.toContain("UNSAFE_SECRET_VALUE");
    expect(wrapper.text().match(new RegExp(missingKey, "gu"))).toHaveLength(1);
  });
});
