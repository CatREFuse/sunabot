import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../types";
import type { AgentSkillRecord, SkillCopyPreview } from "../../types/agentExtensions";
import SkillCopyDialog from "./SkillCopyDialog.vue";

describe("SkillCopyDialog", () => {
  it("shows the complete safe copy preview and submits the selected MCP policy", async () => {
    const wrapper = mount(SkillCopyDialog, {
      props: {
        skill,
        sourceAgentId: "plana",
        agents,
        preview,
        busy: false,
        error: ""
      },
      global: { stubs: { Teleport: true, Transition: false } }
    });

    expect(wrapper.get("form").classes()).toContain("max-h-[calc(100dvh-32px)]");
    expect(wrapper.find('[aria-label="MCP 迁移预览"] .max-h-72').exists()).toBe(true);
    expect(wrapper.text()).toContain("依赖缺失");
    expect(wrapper.text()).toContain("workspace-search");
    expect(wrapper.text()).toContain("github-mcp");
    expect(wrapper.text()).toContain("内容不同");
    expect(wrapper.text()).toContain("目标已停用");
    expect(wrapper.text()).toContain("需要重新授权");
    expect(wrapper.text()).toContain("WORKSPACE_SEARCH_TOKEN · 已配置");
    expect(wrapper.text()).toContain("WORKSPACE_SEARCH_TOKEN · 缺失");

    const revisionTitles = wrapper.findAll('[aria-label="迁移修订"] [title]').map((node) => node.attributes("title"));
    expect(revisionTitles).toEqual([
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
      "f".repeat(64)
    ]);

    const selects = wrapper.findAll<HTMLSelectElement>("select");
    expect(selects[0].element.value).toBe("arona");
    await selects[1].setValue("replace");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("apply")).toEqual([[
      {
        targetAgentId: "arona",
        mcpServerIds: ["workspace-search"],
        conflictStrategy: "replace"
      }
    ]]);
  });
});

const skill: AgentSkillRecord = {
  id: "status-report",
  name: "status-report",
  description: "生成状态报告。",
  license: "MIT",
  compatibility: "Sunabot",
  metadata: {},
  allowedTools: [],
  riskEvidence: {
    reviewVersion: 1,
    reviewStatus: "approved",
    reviewedDigestSha256: "a".repeat(64),
    classification: "instruction-only",
    hasScripts: false,
    hasExternalUrls: false,
    mcpDependencies: [{ id: "workspace-search", description: "工作区搜索", transport: "streamable_http", url: "https://mcp.example.test/v1" }],
    declaredFileAccess: ["read"],
    allowImplicitInvocation: false
  },
  enabled: true,
  entry: "SKILL.md",
  digestSha256: "a".repeat(64),
  fileCount: 1,
  unpackedBytes: 512,
  installedAt: "2026-07-17T00:00:00.000Z",
  source: { kind: "upload" },
  approval: { status: "approved", digestSha256: "a".repeat(64), approvedAt: "2026-07-17T00:01:00.000Z" }
};

const preview: SkillCopyPreview = {
  schemaVersion: 1,
  previewRevision: "f".repeat(64),
  sourceAgentId: "plana",
  targetAgentId: "arona",
  sourceSkillRevision: "1".repeat(64),
  targetSkillRevision: "2".repeat(64),
  sourceMcpRevision: "3".repeat(64),
  targetMcpRevision: "4".repeat(64),
  skill: {
    record: skill,
    contentVersion: "a".repeat(64),
    files: [{ path: "SKILL.md", bytes: 512, sha256: "b".repeat(64) }],
    conflict: "same-content",
    declaredMcpDependencies: skill.riskEvidence.mcpDependencies,
    declaredMcpDependenciesStatus: "missing",
    missingMcpDependencies: ["github-mcp"]
  },
  selectedMcpServers: [{
    server: {
      id: "workspace-search",
      name: "Workspace Search",
      description: "搜索工作区。",
      enabled: false,
      transport: "stdio",
      command: "/usr/bin/workspace-search",
      args: ["--stdio"],
      envKeys: ["WORKSPACE_SEARCH_TOKEN"],
      migrationStatus: "reauthorization_required"
    },
    descriptorVersion: "c".repeat(64),
    conflict: "different-content",
    sourceSecrets: { configuredKeys: ["WORKSPACE_SEARCH_TOKEN"], missingKeys: [] },
    targetSecrets: { configuredKeys: [], missingKeys: ["WORKSPACE_SEARCH_TOKEN"] },
    targetState: "disabled",
    requiresAuthorization: true
  }]
};

const agents: AgentSummary[] = [
  agent("plana", "普拉娜"),
  agent("arona", "阿罗娜")
];

function agent(id: string, name: string): AgentSummary {
  return {
    id,
    name,
    enabled: true,
    workspace: `workspace/business/agents/${id}`,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    accounts: []
  };
}
