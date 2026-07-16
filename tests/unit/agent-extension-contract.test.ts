// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertAgentId,
  assertMcpEnvKey,
  emptyAgentMcpServerIndex,
  emptyAgentSkillIndex,
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
    for (const reserved of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DOCKER_HOST", "SUNABOT_TOKEN", "CODEX_HOME"]) {
      expect(() => assertMcpEnvKey(reserved)).toThrowError(expect.objectContaining({
        code: "AGENT_EXTENSION_ENV_KEY_INVALID"
      }));
    }
  });

  it("keeps MCP descriptors secret-free and stdio-only", () => {
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
      command: "/usr/local/bin/node",
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
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, transport: "http" }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_INVALID" }));
    expect(() => parseAgentMcpServerDescriptor({ ...descriptor, command: "npx" }))
      .toThrowError(expect.objectContaining({ code: "AGENT_EXTENSION_MCP_COMMAND_INVALID" }));
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
    for (const hostCommand of ["/Users/alice/mcp", "/home/alice/mcp", "/tmp/mcp", "file:///usr/bin/mcp"]) {
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
