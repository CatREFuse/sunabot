// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertAgentId,
  assertMcpEnvKey,
  emptyAgentMcpServerIndex,
  emptyAgentSkillIndex,
  mcpDescriptorEnvKeys,
  mcpHttpCredentialEnvironmentKey,
  mcpStdioCredentialEnvironmentKey,
  parseAgentMcpServerDescriptor,
  parseAgentMcpServerIndex,
  parseAgentSkillIndex,
  parseAgentSkillMcpDependency
} from "../../packages/contracts/extensions/agentExtensions.js";
import { parseOpenAiSkillMetadata, parseSkillFrontmatter } from "../../services/extensions/public.js";
import { openAiSkillMetadata, skillMarkdown } from "./agent-extension-fixtures.js";

describe("Agent extension contracts", () => {
  it("accepts the versioned empty contracts and rejects unknown schema versions", () => {
    expect(parseAgentSkillIndex(emptyAgentSkillIndex()).skills).toEqual([]);
    expect(parseAgentMcpServerIndex(emptyAgentMcpServerIndex()).servers).toEqual([]);
    expect(() => parseAgentSkillIndex({ ...emptyAgentSkillIndex(), schemaVersion: 2 }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_SCHEMA_UNSUPPORTED" }));
    expect(() => parseAgentMcpServerIndex({ ...emptyAgentMcpServerIndex(), schemaVersion: 99 }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_SCHEMA_UNSUPPORTED" }));
  });

  it("uses the existing Agent id boundary and rejects reserved MCP environment keys", () => {
    expect(assertAgentId("agent-a")).toBe("agent-a");
    for (const invalid of ["a", "Agent-a", "../agent-a", "agent_a", "a".repeat(33)]) {
      expect(() => assertAgentId(invalid)).toThrow();
    }
    expect(assertMcpEnvKey("GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    for (const reserved of [
      "PATH", "HOME", "PWD", "SHELL", "USER", "LOGNAME", "TERM", "NODE_OPTIONS", "LD_PRELOAD",
      "DOCKER_HOST", "SUNABOT_TOKEN", "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY",
      "NO_PROXY", "SERVICE_PROXY"
    ]) {
      expect(() => assertMcpEnvKey(reserved)).toThrowError(expect.objectContaining({
        code: "AGENT_EXTENSION_ENV_KEY_INVALID"
      }));
    }
  });

  it("keeps MCP descriptors secret-free and accepts hardened stdio or Streamable HTTP", () => {
    const descriptor = {
      id: "github-mcp",
      name: "GitHub MCP",
      description: "Provides repository tools.",
      enabled: true,
      transport: "stdio",
      command: "/usr/bin/github-mcp",
      args: ["--stdio"],
      envKeys: ["GITHUB_TOKEN"]
    };
    expect(parseAgentMcpServerDescriptor(descriptor)).toEqual(descriptor);
    expect(parseAgentMcpServerDescriptor({
      ...descriptor,
      args: [
        "--stdio",
        "--mode=safe",
        "--config=/workbench/config/server.json",
        "--endpoint=https://mcp.example.test/v1"
      ]
    }).args).toEqual([
      "--stdio",
      "--mode=safe",
      "--config=/workbench/config/server.json",
      "--endpoint=https://mcp.example.test/v1"
    ]);
    expect(parseAgentMcpServerDescriptor({
      ...descriptor,
      args: ["--query=issues"]
    }).args).toEqual(["--query=issues"]);
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, token: "secret" }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_CONFIG_INVALID" }));
    expect(parseAgentMcpServerDescriptor({
      id: "remote-mcp",
      name: "Remote MCP",
      description: "Remote tools.",
      enabled: true,
      required: false,
      enabledTools: ["search"],
      disabledTools: ["delete"],
      ordinaryUserTools: ["search"],
      approvalMode: "never",
      transport: "streamable_http",
      url: "https://mcp.example.test/v1",
      auth: { kind: "none" }
    })).toMatchObject({
      transport: "streamable_http",
      url: "https://mcp.example.test/v1",
      auth: { kind: "none" }
    });
    for (const auth of [
      { kind: "bearer", credentialRef: "mcp/remote-token" },
      { kind: "oauth", credentialRef: `mcpcred_${"a".repeat(24)}` }
    ]) {
      expect(() => parseAgentMcpServerDescriptor({
        id: "credential-mcp",
        name: "Credential MCP",
        description: "Credential tools.",
        enabled: true,
        required: false,
        enabledTools: ["search"],
        disabledTools: [],
        ordinaryUserTools: ["search"],
        approvalMode: "never",
        transport: "streamable_http",
        url: "https://mcp.example.test/v1",
        auth
      })).toThrowError(expect.objectContaining({
        code: "AGENT_EXTENSION_MCP_ORDINARY_USER_CREDENTIAL_FORBIDDEN"
      }));
    }
    expect(() => parseAgentMcpServerDescriptor({
      ...descriptor,
      required: false,
      enabledTools: ["search"],
      disabledTools: [],
      ordinaryUserTools: ["search"],
      approvalMode: "never"
    })).toThrowError(expect.objectContaining({
      code: "AGENT_EXTENSION_MCP_ORDINARY_USER_CREDENTIAL_FORBIDDEN"
    }));
    expect(() => parseAgentMcpServerDescriptor({
      id: "remote-mcp",
      name: "Remote MCP",
      description: "Remote tools.",
      enabled: true,
      required: false,
      enabledTools: ["search"],
      disabledTools: [],
      ordinaryUserTools: ["delete"],
      approvalMode: "never",
      transport: "streamable_http",
      url: "https://mcp.example.test/v1",
      auth: { kind: "none" }
    })).toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_INVALID" }));
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, transport: "http" }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_CONFIG_INVALID" }));
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, command: "npx" }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_COMMAND_INVALID" }));
    for (const interpreter of [
      "/usr/local/bin/node", "/usr/bin/python3", "/bin/sh", "/usr/bin/env", "/usr/bin/ruby3.2"
    ]) {
      expect(() => parseAgentMcpServerDescriptor({ ...descriptor, command: interpreter }))
        .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_COMMAND_INVALID" }));
    }
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, args: ["--token=plain-secret"] }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_SECRET_ARGUMENT_REJECTED" }));
    for (const secretArg of [
      "Authorization: Bearer abcdefgh", "--header=X-API-Key: abcdefgh", "https://user:pass@example.test/mcp",
      "https://example.test/mcp?access_token=abcdefgh", "-----BEGIN PRIVATE KEY-----", "ghp_1234567890abcdef",
      "%41uthorization%3A%20Bearer%20abcdefgh",
      "%2541uthorization%253A%2520Bearer%2520abcdefgh",
      Buffer.from("Authorization: Bearer abcdefgh").toString("base64"),
      "Qm7vK2pN9xR4sT8uW1yZ6cD0"
    ]) {
      expect(() => parseAgentMcpServerDescriptor({ ...descriptor, args: [secretArg] }))
        .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_SECRET_ARGUMENT_REJECTED" }));
    }
    for (const unsafePath of [
      "/Users/alice/.config/mcp", "/home/alice/mcp", "/tmp/mcp", "C:/Users/alice/mcp.exe",
      "\\\\server\\share\\mcp", "file:///workbench/mcp", "/workbench/../outside"
    ]) {
      expect(() => parseAgentMcpServerDescriptor({ ...descriptor, args: [unsafePath] }))
        .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_ARGUMENT_INVALID" }));
    }
    for (const invalidText of ["bad\tvalue", "bad\u0085value", `bad${String.fromCharCode(0xD800)}value`]) {
      expect(() => parseAgentMcpServerDescriptor({ ...descriptor, description: invalidText }))
        .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_VALUE_INVALID" }));
    }
    for (const hostCommand of [
      "/Users/alice/mcp",
      "/home/alice/mcp",
      "/tmp/mcp",
      "/opt/example/bin/mcp",
      "/app/bin/mcp",
      "file:///usr/bin/mcp"
    ]) {
      expect(() => parseAgentMcpServerDescriptor({ ...descriptor, command: hostCommand }))
        .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_COMMAND_INVALID" }));
    }
    const base64Authorization = Buffer.from("Authorization: Bearer abcdefgh")
      .toString("base64")
      .replace(/=+$/u, "");
    const twiceBase64Authorization = Buffer.from(base64Authorization)
      .toString("base64")
      .replace(/=+$/u, "");
    for (const secretCommand of [
      "/usr/bin/ghp_1234567890abcdef",
      "/opt/ghp_1234567890abcdef/bin/github-mcp",
      `/usr/bin/${base64Authorization}`,
      `/usr/bin/${twiceBase64Authorization}`
    ]) {
      expect(() => parseAgentMcpServerDescriptor({ ...descriptor, command: secretCommand }))
        .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_COMMAND_INVALID" }));
    }
    expect(parseAgentMcpServerDescriptor({
      ...descriptor,
      command: "/usr/bin/semantic-code-indexer-runner"
    }).command).toBe("/usr/bin/semantic-code-indexer-runner");
    let decodingLimit = "relative/path";
    for (let depth = 0; depth < 7; depth += 1) decodingLimit = encodeURIComponent(decodingLimit);
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, args: [decodingLimit] }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_ARGUMENT_INVALID" }));
  });

  it("derives stable Agent-bound bearer environment names without exposing credential references", () => {
    const bearer = parseAgentMcpServerDescriptor({
      id: "remote-mcp",
      name: "Remote MCP",
      description: "Remote tools.",
      enabled: true,
      required: false,
      enabledTools: [],
      disabledTools: [],
      approvalMode: "always",
      transport: "streamable_http",
      url: "https://mcp.example.test/v1",
      auth: { kind: "bearer", credentialRef: "mcp/remote-token" }
    });
    const key = mcpHttpCredentialEnvironmentKey("agent-a", bearer.id, "mcp/remote-token", bearer.url);
    expect(key).toMatch(/^SUNABOT_MCP_HTTP_BEARER_[A-F0-9]{32}$/u);
    expect(key).not.toContain("REMOTE_TOKEN");
    expect(mcpDescriptorEnvKeys(bearer)).toEqual([]);
    expect(mcpDescriptorEnvKeys(bearer, "agent-a")).toEqual([key]);
    expect(mcpHttpCredentialEnvironmentKey("agent-a", bearer.id, "mcp/remote-token", bearer.url)).toBe(key);
    expect(mcpHttpCredentialEnvironmentKey("agent-b", bearer.id, "mcp/remote-token", bearer.url)).not.toBe(key);
    expect(mcpHttpCredentialEnvironmentKey(
      "agent-a", bearer.id, "mcp/remote-token", "https://other.example.test/mcp"
    )).not.toBe(key);
    expect(mcpDescriptorEnvKeys({ ...bearer, auth: { kind: "oauth", credentialRef: "mcp/oauth" } }, "agent-a"))
      .toEqual([]);
  });

  it("keeps stdio descriptor keys logical while deriving Agent and server bound environment names", () => {
    const server = parseAgentMcpServerDescriptor({
      id: "local-mcp",
      name: "Local MCP",
      description: "Local tools.",
      enabled: false,
      transport: "stdio",
      command: "/usr/bin/local-mcp",
      args: [],
      envKeys: ["TOKEN"]
    });
    const agentAKey = mcpStdioCredentialEnvironmentKey("agent-a", server.id, "TOKEN");

    expect(server).toMatchObject({ envKeys: ["TOKEN"] });
    expect(mcpDescriptorEnvKeys(server)).toEqual(["TOKEN"]);
    expect(mcpDescriptorEnvKeys(server, "agent-a")).toEqual([agentAKey]);
    expect(agentAKey).toMatch(/^SUNABOT_MCP_STDIO_SECRET_[A-F0-9]{32}$/u);
    expect(agentAKey).not.toContain("TOKEN");
    expect(mcpStdioCredentialEnvironmentKey("agent-a", server.id, "TOKEN")).toBe(agentAKey);
    expect(mcpStdioCredentialEnvironmentKey("agent-b", server.id, "TOKEN")).not.toBe(agentAKey);
    expect(mcpStdioCredentialEnvironmentKey("agent-a", "other-mcp", "TOKEN")).not.toBe(agentAKey);
    expect(mcpStdioCredentialEnvironmentKey("agent-a", server.id, "OTHER_TOKEN")).not.toBe(agentAKey);
  });

  it("parses the bounded official Skill frontmatter fields and rejects complex YAML", () => {
    expect(parseSkillFrontmatter(skillMarkdown())).toEqual({
      name: "test-skill",
      description: "Handles test requests when the user asks for the test workflow.",
      license: null,
      compatibility: null,
      metadata: {},
      allowedTools: []
    });
    expect(parseSkillFrontmatter(skillMarkdown(
      "test-skill",
      "Handles test requests.",
      "Body",
      "license: MIT\ncompatibility: Requires git.\nmetadata:\n  author: Sunabot\n  version: '1'\nallowed-tools: [Read, 'Bash(git:*)', write_file]"
    ))).toEqual({
      name: "test-skill",
      description: "Handles test requests.",
      license: "MIT",
      compatibility: "Requires git.",
      metadata: { author: "Sunabot", version: "1" },
      allowedTools: ["Bash(git:*)", "Read", "write_file"]
    });
    expect(() => parseSkillFrontmatter(skillMarkdown("claude-helper")))
      .toThrowError(expect.objectContaining({ code: "SKILL_NAME_RESERVED" }));
    for (const invalidName of ["-test", "test-", "test--skill", "Test-skill"]) {
      expect(() => parseSkillFrontmatter(skillMarkdown(invalidName))).toThrow();
    }
    expect(() => parseSkillFrontmatter(skillMarkdown("test-skill", "Use <tool> for tests.")))
      .toThrowError(expect.objectContaining({ code: "SKILL_DESCRIPTION_INVALID" }));
    expect(() => parseSkillFrontmatter(
      "---\nname: test-skill\ndescription: Handles tests when requested.\nunknown: value\n---\nBody\n"
    )).toThrowError(expect.objectContaining({ code: "SKILL_FRONTMATTER_INVALID" }));
    for (const complex of [
      "metadata: {author: Sunabot}",
      "description: |\n  multiline",
      "license: &license MIT",
      "compatibility: *license",
      "allowed-tools:\n  - Read"
    ]) {
      expect(() => parseSkillFrontmatter(
        `---\nname: test-skill\ndescription: Handles tests when requested.\n${complex}\n---\nBody\n`
      )).toThrowError(expect.objectContaining({ code: "SKILL_FRONTMATTER_INVALID" }));
    }
    expect(() => parseSkillFrontmatter(skillMarkdown("test-skill", undefined, Array.from({ length: 500 }, () => "line").join("\n"))))
      .toThrowError(expect.objectContaining({ code: "SKILL_BODY_LINE_LIMIT" }));
  });

  it("parses only the safe OpenAI skill policy and MCP dependency hints", () => {
    expect(parseOpenAiSkillMetadata(openAiSkillMetadata())).toEqual({
      allowImplicitInvocation: false,
      mcpDependencies: [{
        id: "github-mcp",
        description: "Repository tools",
        transport: "streamable_http",
        url: "https://mcp.example.test/v1/"
      }]
    });
    expect(parseAgentSkillMcpDependency({
      id: "github-mcp",
      description: "Repository tools",
      transport: "streamable_http",
      url: "https://mcp.example.test/v1/"
    }).id).toBe("github-mcp");
    for (const invalid of [
      openAiSkillMetadata().replace("streamable_http", "stdio"),
      openAiSkillMetadata().replace("https://mcp.example.test/v1/", "http://mcp.example.test/v1/"),
      openAiSkillMetadata().replace("https://mcp.example.test/v1/", "https://user:pass@mcp.example.test/v1/"),
      `${openAiSkillMetadata()}unknown:\n  nested: true\n`,
      openAiSkillMetadata().replace('value: "github-mcp"', "value: &server github-mcp")
    ]) {
      expect(() => parseOpenAiSkillMetadata(invalid))
        .toThrowError(expect.objectContaining({ code: expect.stringMatching(/^SKILL_/u) }));
    }
  });
});
