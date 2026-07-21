// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import { retainTerminalSkillJournal } from "../../adapters/filesystem/agentSkillPersistence.js";
import { moveVerifiedSkillDirectory } from "../../adapters/filesystem/agentSkillSafeMutation.js";
import { inspectSkillDirectory } from "../../adapters/filesystem/skillArchive.js";
import { AgentExtensionService } from "../../services/extensions/public.js";
import { mcpStdioCredentialEnvironmentKey } from "../../packages/contracts/extensions/agentExtensions.js";
import {
  makeStoredZip,
  openAiSkillMetadata,
  skillMarkdown
} from "./agent-extension-fixtures.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const temporaryPaths: string[] = [];
let workspace = "";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-extensions-"));
  temporaryPaths.push(workspace);
  await fs.mkdir(path.join(workspace, "business/agents/agent-a"), { recursive: true });
  await fs.mkdir(path.join(workspace, "business/agents/agent-b"), { recursive: true });
  await fs.chmod(path.join(workspace, "business/agents"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/agent-a"), 0o700);
  await fs.chmod(path.join(workspace, "business/agents/agent-b"), 0o700);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((candidate) => fs.rm(candidate, {
    recursive: true,
    force: true
  })));
});

describe("Agent extension filesystem store", () => {
  it("creates only the versioned per-Agent extension layout and never creates a plaintext credential tree", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.ensureLayout("agent-a");
    await store.ensureLayout("agent-a");
    const skills = JSON.parse(await fs.readFile(skillIndex("agent-a"), "utf8"));
    const mcp = JSON.parse(await fs.readFile(mcpIndex("agent-a"), "utf8"));
    expect(skills).toMatchObject({ schemaVersion: 1, skills: [] });
    expect(skills.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(mcp).toMatchObject({ schemaVersion: 1, servers: [] });
    await expect(fs.access(path.join(workspace, "secrets"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(path.dirname(skillIndex("agent-a")))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(skillIndex("agent-a"))).mode & 0o777).toBe(0o600);
  });

  it("validates both existing indexes before taking the ensureLayout fast path", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.ensureLayout("agent-a");
    await fs.writeFile(skillIndex("agent-a"), "{}\n", { mode: 0o600 });
    await expect(store.ensureLayout("agent-a"))
      .rejects.toMatchObject({ code: expect.stringMatching(/^AGENT_EXTENSION_/u) });
    expect(await fs.readFile(mcpIndex("agent-a"), "utf8")).not.toBe("{}\n");
  });

  it("singleflights concurrent layout recovery for the same Agent", async () => {
    await new AgentExtensionStore({ workspaceRoot: workspace }).ensureLayout("agent-a");
    let pauseRecovery!: () => void;
    let resumeRecovery!: () => void;
    const paused = new Promise<void>((resolve) => { pauseRecovery = resolve; });
    const resume = new Promise<void>((resolve) => { resumeRecovery = resolve; });
    let recoveryLockAttempts = 0;
    const store = new AgentExtensionStore({
      workspaceRoot: workspace,
      async beforePathOperation(operation) {
        if (operation !== "acquire-extension-lock") return;
        recoveryLockAttempts += 1;
        if (recoveryLockAttempts !== 1) return;
        pauseRecovery();
        await resume;
      }
    });

    const first = store.ensureLayout("agent-a");
    await paused;
    const second = store.ensureLayout("agent-a");
    resumeRecovery();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(recoveryLockAttempts).toBe(1);
  });

  it("installs one public Skill name per Agent and persists strict metadata as unreviewed evidence", async () => {
    const service = new AgentExtensionService(new AgentExtensionStore({
      workspaceRoot: workspace,
      now: () => new Date("2026-07-17T00:00:00.000Z")
    }));
    const archive = fullSkillZip("Initial behavior");
    const installed = await service.installSkill({ agentId: "agent-a", archive });
    expect(installed).toMatchObject({
      id: "test-skill",
      license: "MIT",
      compatibility: "Requires git.",
      metadata: { author: "Sunabot" },
      allowedTools: ["Bash(git:*)", "Read", "write_file"],
      source: { kind: "upload" },
      riskEvidence: {
        reviewVersion: 1,
        reviewStatus: "unreviewed",
        reviewedDigestSha256: null,
        classification: "script-bearing",
        hasScripts: true,
        hasExternalUrls: true,
        externalOrigins: ["https://docs.example.test", "https://mcp.example.test"],
        declaredFileAccess: ["read", "write", "shell"],
        allowImplicitInvocation: false,
        mcpDependencies: [{ id: "github-mcp" }]
      }
    });
    await expect(service.installSkill({ agentId: "agent-a", archive: skillZip("Same public name") }))
      .rejects.toMatchObject({ code: "SKILL_CONFLICT" });
    const replacement = await service.installSkill({
      agentId: "agent-a",
      archive: fullSkillZip("Replacement behavior"),
      replace: true
    });
    expect(replacement.digestSha256).not.toBe(installed.digestSha256);
    expect(replacement.riskEvidence.reviewStatus).toBe("unreviewed");
    expect((await service.overview("agent-a")).skills).toHaveLength(1);
  }, 20_000);

  it("uses an injected status resolver and keeps MCP dependency declarations as preview-only hints", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const statusResolver = vi.fn(async ({ agentId, envKeys }: { agentId: string; envKeys: string[] }) => ({
      configuredKeys: agentId === "agent-a" ? [...envKeys] : [],
      missingKeys: agentId === "agent-a" ? [] : [...envKeys]
    }));
    const service = new AgentExtensionService(store, statusResolver);
    const installed = await service.installSkill({ agentId: "agent-a", archive: fullSkillZip("Preview behavior") });
    const descriptor = mcpDescriptor();
    const sourceKey = mcpStdioCredentialEnvironmentKey("agent-a", descriptor.id, "GITHUB_TOKEN");
    const targetKey = mcpStdioCredentialEnvironmentKey("agent-b", descriptor.id, "GITHUB_TOKEN");
    await store.putMcpServer({ agentId: "agent-a", server: descriptor, replace: false });

    const missing = await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: installed.id,
      mcpServerIds: [descriptor.id]
    });
    expect(missing.skill).toMatchObject({
      declaredMcpDependenciesStatus: "missing",
      missingMcpDependencies: ["github-mcp"],
      declaredMcpDependencies: [{ id: "github-mcp" }]
    });
    expect(missing.selectedMcpServers[0]).toMatchObject({
      server: {
        enabled: false,
        envKeys: ["GITHUB_TOKEN"],
        migrationStatus: "reauthorization_required"
      },
      sourceSecrets: { configuredKeys: [sourceKey], missingKeys: [] },
      targetSecrets: { configuredKeys: [], missingKeys: [targetKey] },
      targetState: "disabled",
      requiresAuthorization: true
    });
    await store.putMcpServer({ agentId: "agent-b", server: descriptor, replace: false });
    const declared = await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: installed.id
    });
    expect(declared.skill.declaredMcpDependenciesStatus).toBe("declared");
    expect(declared.skill.missingMcpDependencies).toEqual([]);
    expect(statusResolver).toHaveBeenCalledWith({
      agentId: "agent-a",
      serverId: "github-mcp",
      envKeys: [sourceKey]
    });
    expect(statusResolver).toHaveBeenCalledWith({
      agentId: "agent-b",
      serverId: "github-mcp",
      envKeys: [targetKey]
    });
    expect(JSON.stringify(missing)).not.toContain("credential-value");
    await expect(fs.access(path.join(workspace, "secrets"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("applies a CAS-bound cross-Agent copy without shared inodes and keeps the copied Skill disabled", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    let targetSecretConfigured = false;
    const service = new AgentExtensionService(store, async ({ agentId, envKeys }) => {
      const configured = agentId === "agent-a" || (agentId === "agent-b" && targetSecretConfigured);
      return configured
        ? { configuredKeys: [...envKeys], missingKeys: [] }
        : { configuredKeys: [], missingKeys: [...envKeys] };
    });
    const source = await service.installSkill({ agentId: "agent-a", archive: skillZip("Copy behavior") });
    await store.putMcpServer({ agentId: "agent-a", server: mcpDescriptor(), replace: false });
    const targetKey = mcpStdioCredentialEnvironmentKey("agent-b", "github-mcp", "GITHUB_TOKEN");
    const preview = await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      mcpServerIds: ["github-mcp"]
    });
    expect((await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      mcpServerIds: ["github-mcp"]
    })).previewRevision).toBe(preview.previewRevision);
    await store.ensureLayout("agent-b");
    expect((await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      mcpServerIds: ["github-mcp"]
    })).previewRevision).toBe(preview.previewRevision);
    const result = await service.applyCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      mcpServerIds: ["github-mcp"],
      previewRevision: preview.previewRevision,
      conflictStrategy: "replace"
    });
    expect(result).toMatchObject({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skipped: false,
      skill: {
        id: "test-skill",
        enabled: false,
        source: { kind: "copy", agentId: "agent-a", skillId: "test-skill" },
        riskEvidence: { reviewStatus: "unreviewed", reviewedDigestSha256: null },
        approval: { status: "unapproved", digestSha256: null, approvedAt: null }
      },
      mcpServers: [{
        id: "github-mcp",
        enabled: false,
        envKeys: ["GITHUB_TOKEN"],
        migrationStatus: "reauthorization_required"
      }]
    });
    await expect(service.setMcpServerEnabled({
      agentId: "agent-b",
      serverId: "github-mcp",
      enabled: true
    })).rejects.toMatchObject({ code: "MCP_REAUTHORIZATION_REQUIRED" });
    expect((await service.overview("agent-b")).mcp.secrets)
      .toEqual({ configuredKeys: [], missingKeys: [targetKey] });
    targetSecretConfigured = true;
    await expect(service.setMcpServerEnabled({
      agentId: "agent-b",
      serverId: "github-mcp",
      enabled: true
    })).rejects.toMatchObject({ code: "MCP_REAUTHORIZATION_REQUIRED" });
    const migrated = result.mcpServers[0]!;
    const { migrationStatus: _migrationStatus, ...reauthorized } = migrated;
    const reauthorizationPreview = await service.previewMcpServer({
      agentId: "agent-b",
      server: reauthorized
    });
    await service.putMcpServer({
      agentId: "agent-b",
      server: reauthorized,
      replace: true,
      previewRevision: reauthorizationPreview.previewRevision,
      approveCommand: true
    });
    targetSecretConfigured = false;
    await expect(service.setMcpServerEnabled({
      agentId: "agent-b",
      serverId: "github-mcp",
      enabled: true
    })).rejects.toMatchObject({ code: "MCP_CREDENTIALS_REQUIRED" });
    targetSecretConfigured = true;
    await expect(service.setMcpServerEnabled({
      agentId: "agent-b",
      serverId: "github-mcp",
      enabled: true
    })).resolves.toMatchObject({ enabled: true, envKeys: ["GITHUB_TOKEN"] });
    expect(await extensionFileContents("agent-b")).not.toContain("credential-value");
    const sourceStat = await fs.stat(path.join(skillsRoot("agent-a"), "test-skill/SKILL.md"), { bigint: true });
    const targetStat = await fs.stat(path.join(skillsRoot("agent-b"), "test-skill/SKILL.md"), { bigint: true });
    expect({ dev: targetStat.dev, ino: targetStat.ino }).not.toEqual({ dev: sourceStat.dev, ino: sourceStat.ino });

    const reviewed = await service.reviewSkill({
      agentId: "agent-b",
      skillId: "test-skill",
      approve: true
    });
    expect(reviewed).toMatchObject({
      enabled: false,
      riskEvidence: { reviewStatus: "approved", reviewedDigestSha256: reviewed.digestSha256 },
      approval: { status: "approved", digestSha256: reviewed.digestSha256 }
    });
    const approved = await service.setSkillEnabled({ agentId: "agent-b", skillId: "test-skill", enabled: true });
    expect(approved.approval).toMatchObject({
      status: "approved",
      digestSha256: approved.digestSha256
    });
    await expect(service.applyCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      previewRevision: preview.previewRevision,
      conflictStrategy: "skip"
    })).rejects.toMatchObject({ code: "AGENT_EXTENSION_COPY_PREVIEW_STALE" });
  }, 30_000);

  it("migrates only disabled MCP configuration and requires target-side authorization", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store, async ({ agentId, envKeys }) => ({
      configuredKeys: agentId === "agent-a" ? [...envKeys] : [],
      missingKeys: agentId === "agent-a" ? [] : [...envKeys]
    }));
    const source = await service.installSkill({ agentId: "agent-a", archive: skillZip("MCP migration") });
    const bearer = httpMcpDescriptor("bearer-mcp", {
      kind: "bearer" as const,
      credentialRef: "mcp/source-bearer"
    });
    const sourceOAuthHandle = `mcpcred_${"A".repeat(24)}`;
    const oauth = httpMcpDescriptor("oauth-mcp", {
      kind: "oauth" as const,
      credentialRef: sourceOAuthHandle
    });
    await store.putMcpServer({ agentId: "agent-a", server: bearer, replace: false });
    await store.putMcpServer({ agentId: "agent-a", server: oauth, replace: false });

    const preview = await service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      mcpServerIds: [bearer.id, oauth.id]
    });
    expect(JSON.stringify(preview)).not.toContain(sourceOAuthHandle);
    expect(preview.selectedMcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        server: expect.objectContaining({
          id: "bearer-mcp",
          enabled: false,
          auth: { kind: "bearer", credentialRef: "pending" },
          migrationStatus: "reauthorization_required"
        }),
        targetState: "disabled",
        requiresAuthorization: true
      }),
      expect.objectContaining({
        server: expect.objectContaining({
          id: "oauth-mcp",
          enabled: false,
          auth: { kind: "oauth", credentialRef: "pending" },
          migrationStatus: "reauthorization_required"
        }),
        targetState: "disabled",
        requiresAuthorization: true
      })
    ]));

    const result = await service.applyCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: source.id,
      mcpServerIds: [bearer.id, oauth.id],
      previewRevision: preview.previewRevision,
      conflictStrategy: "replace"
    });
    expect(JSON.stringify(result)).not.toContain(sourceOAuthHandle);
    const target = await store.readMcpServerIndex("agent-b");
    expect(target.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bearer-mcp", enabled: false, auth: { kind: "bearer", credentialRef: "pending" } }),
      expect.objectContaining({ id: "oauth-mcp", enabled: false, auth: { kind: "oauth", credentialRef: "pending" } })
    ]));
    for (const serverId of [bearer.id, oauth.id]) {
      await expect(service.setMcpServerEnabled({ agentId: "agent-b", serverId, enabled: true }))
        .rejects.toMatchObject({ code: "MCP_REAUTHORIZATION_REQUIRED" });
    }

    const reboundHandle = `mcpcred_${"B".repeat(24)}`;
    const rebound = await store.bindMcpOAuthCredential({
      agentId: "agent-b",
      serverId: oauth.id,
      expectedRevision: target.revision,
      expectedUrl: oauth.url,
      credentialRef: reboundHandle
    });
    expect(rebound).toMatchObject({
      enabled: false,
      auth: { kind: "oauth", credentialRef: reboundHandle }
    });
    expect(rebound).not.toHaveProperty("migrationStatus");
  }, 20_000);

  it("defaults every required credential to missing and rejects malformed resolver partitions", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.putMcpServer({ agentId: "agent-a", server: mcpDescriptor(), replace: false });
    const requiredKey = mcpStdioCredentialEnvironmentKey("agent-a", "github-mcp", "GITHUB_TOKEN");
    const defaultService = new AgentExtensionService(store);
    expect((await defaultService.overview("agent-a")).mcp.secrets)
      .toEqual({ configuredKeys: [], missingKeys: [requiredKey] });

    const invalid = new AgentExtensionService(store, async () => ({
      configuredKeys: [requiredKey],
      missingKeys: [requiredKey]
    }));
    await expect(invalid.overview("agent-a"))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_CREDENTIAL_STATUS_INVALID" });
  }, 20_000);

  it("maps credential resolver throws to one fixed error without leaking through overview, preview, logs, or disk", async () => {
    const privatePath = "/private/workspace/business/agents/agent-a/extensions/mcp/servers.json";
    const secretValue = "Bearer resolver-secret-value";
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const installed = await new AgentExtensionService(store).installSkill({
      agentId: "agent-a",
      archive: fullSkillZip("Resolver failure preview")
    });
    await store.putMcpServer({ agentId: "agent-a", server: mcpDescriptor(), replace: false });
    const thrown = Object.assign(new Error(`${secretValue} at ${privatePath}`), {
      cause: { message: secretValue, path: privatePath },
      path: privatePath
    });
    const service = new AgentExtensionService(store, async () => { throw thrown; });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    for (const operation of [
      () => service.overview("agent-a"),
      () => service.previewCopy({
        sourceAgentId: "agent-a",
        targetAgentId: "agent-b",
        skillId: installed.id,
        mcpServerIds: ["github-mcp"]
      })
    ]) {
      const error = await operation().then(() => undefined, (failure: unknown) => failure) as Error & {
        statusCode?: number;
        code?: string;
        cause?: unknown;
      };
      expect(error).toMatchObject({
        statusCode: 503,
        code: "AGENT_EXTENSION_CREDENTIAL_STATUS_INVALID",
        message: "MCP 凭据状态暂时不可用。"
      });
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(secretValue);
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(privatePath);
    }

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(await fs.readFile(mcpIndex("agent-a"), "utf8")).not.toContain(secretValue);
    expect(await fs.readFile(mcpIndex("agent-a"), "utf8")).not.toContain(privatePath);
    expect(await extensionFileContents("agent-a")).not.toContain(secretValue);
    expect(await extensionFileContents("agent-a")).not.toContain(privatePath);
  }, 20_000);

  it("revalidates secret-free MCP descriptors at the filesystem write boundary", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const rejected = [
      "--token=plain-secret",
      Buffer.from("Authorization: Bearer credential-value").toString("base64"),
      "%2541uthorization%253A%2520Bearer%2520credential-value",
      "Qm7vK2pN9xR4sT8uW1yZ6cD0"
    ];
    for (const argument of rejected) {
      await expect(store.putMcpServer({
        agentId: "agent-a",
        server: { ...mcpDescriptor(), args: [argument] },
        replace: false
      })).rejects.toMatchObject({ code: "AGENT_EXTENSION_MCP_SECRET_ARGUMENT_REJECTED" });
    }
    for (const argument of [
      "--config=/Users/alice/.mcp/config.json",
      "--config=C:/Users/alice/mcp.json",
      "--config=%252FUsers%252Falice%252F.mcp",
      Buffer.from("/home/alice/.mcp/config.json").toString("base64"),
      "a".repeat(64),
      "A2".repeat(24)
    ]) {
      await expect(store.putMcpServer({
        agentId: "agent-a",
        server: { ...mcpDescriptor(), args: [argument] },
        replace: false
      })).rejects.toMatchObject({
        code: expect.stringMatching(/AGENT_EXTENSION_MCP_(?:SECRET_ARGUMENT_REJECTED|ARGUMENT_INVALID)/u)
      });
    }
    for (const command of [
      `/usr/bin/${"a".repeat(64)}`,
      "/usr/bin/ghp_1234567890abcdef",
      `/usr/bin/${Buffer.from("Authorization: Bearer credential-value")
        .toString("base64").replace(/=+$/u, "")}`
    ]) {
      await expect(store.putMcpServer({
        agentId: "agent-a",
        server: { ...mcpDescriptor(), command },
        replace: false
      })).rejects.toMatchObject({ code: "AGENT_EXTENSION_MCP_COMMAND_INVALID" });
    }
    await store.ensureLayout("agent-a");
    expect((await store.readMcpServerIndex("agent-a")).servers).toEqual([]);
    const before = await extensionFileContents("agent-a");
    expect(before).not.toContain("credential-value");
    expect(before).not.toContain(rejected[1]);

    await store.putMcpServer({
      agentId: "agent-a",
      server: { ...mcpDescriptor(), args: ["--query=issues"] },
      replace: false
    });
    const overview = await new AgentExtensionService(store, async ({ envKeys }) => ({
      configuredKeys: [...envKeys],
      missingKeys: []
    })).overview("agent-a");
    expect(JSON.stringify(overview)).not.toContain("credential-value");
    expect(await extensionFileContents("agent-a")).not.toContain("credential-value");
  });

  it("retains verified journals and quarantine or tombstone directories instead of recursively deleting evidence", async () => {
    const service = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    const first = await service.installSkill({ agentId: "agent-a", archive: skillZip("Initial behavior") });
    const replaced = await service.installSkill({
      agentId: "agent-a",
      archive: skillZip("Replacement behavior"),
      replace: true
    });
    const afterReplace = await fs.readdir(skillsRoot("agent-a"));
    expect(afterReplace.some((entry) => entry.startsWith(".skill-committed-transaction-"))).toBe(true);
    expect(afterReplace.some((entry) => entry.startsWith(".skill-quarantine-test-skill-"))).toBe(true);
    expect((await service.overview("agent-a")).skills[0]?.digestSha256).toBe(replaced.digestSha256);

    await service.uninstallSkill({ agentId: "agent-a", skillId: first.id });
    const afterRemove = await fs.readdir(skillsRoot("agent-a"));
    expect(afterRemove.some((entry) => entry.startsWith(".skill-committed-remove-transaction-"))).toBe(true);
    expect(afterRemove.some((entry) => entry.startsWith(".skill-tombstone-test-skill-"))).toBe(true);
    await expect(fs.access(path.join(skillsRoot("agent-a"), "test-skill")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.overview("agent-a")).skills).toEqual([]);
  });

  it("reconciles terminal journal source/terminal states idempotently and fails closed on conflicts", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.ensureLayout("agent-a");
    const transaction = {
      schemaVersion: 1 as const,
      state: "prepared" as const,
      id: "test-skill",
      previousDigest: null,
      nextDigest: "a".repeat(64),
      stageName: ".skill-publish-test",
      backupName: ".skill-quarantine-test-skill-test"
    };
    const source = path.join(skillsRoot("agent-a"), ".skill-transaction-11111111-1111-4111-8111-111111111111.json");
    const terminal = path.join(skillsRoot("agent-a"), ".skill-committed-transaction-11111111-1111-4111-8111-111111111111.json");
    await fs.writeFile(source, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
    await expect((retainTerminalSkillJournal as any)(source, transaction, "committed", {
      renameFaultAt: "after_rename_before_response"
    })).resolves.toBe(terminal);
    await expect(retainTerminalSkillJournal(source, transaction, "committed")).resolves.toBe(terminal);
    await fs.writeFile(source, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
    await expect(retainTerminalSkillJournal(source, transaction, "committed"))
      .rejects.toMatchObject({ code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });

    const missing = path.join(skillsRoot("agent-a"), ".skill-transaction-22222222-2222-4222-8222-222222222222.json");
    await expect(retainTerminalSkillJournal(missing, transaction, "committed"))
      .rejects.toMatchObject({ code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });

    for (const [index, renameWorkerFailureMode] of ["pause_before_response", "truncate_response"].entries()) {
      const token = index === 0
        ? "33333333-3333-4333-8333-333333333333"
        : "44444444-4444-4444-8444-444444444444";
      const realSource = path.join(skillsRoot("agent-a"), `.skill-transaction-${token}.json`);
      const realTerminal = path.join(skillsRoot("agent-a"), `.skill-committed-transaction-${token}.json`);
      await fs.writeFile(realSource, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
      await expect(retainTerminalSkillJournal(realSource, transaction, "committed", {
        renameWorkerFailureMode: renameWorkerFailureMode as "pause_before_response" | "truncate_response",
        renameWorkerTimeoutMs: 150
      })).resolves.toBe(realTerminal);
      await expect(fs.access(realSource)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(realTerminal, "utf8")).toBe(`${JSON.stringify({
        ...transaction,
        state: "committed"
      }, null, 2)}\n`);
    }
  });

  it("requires committed replacement quarantine and uninstall tombstone evidence during active recovery", async () => {
    const service = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    await service.installSkill({ agentId: "agent-a", archive: skillZip("Version A") });
    await service.installSkill({ agentId: "agent-a", archive: skillZip("Version B"), replace: true });
    let replacementTerminal: string | undefined;
    for (const entry of await fs.readdir(skillsRoot("agent-a"))) {
      if (!entry.startsWith(".skill-committed-transaction-")) continue;
      const candidate = JSON.parse(await fs.readFile(path.join(skillsRoot("agent-a"), entry), "utf8"));
      if (candidate.previousDigest !== null) replacementTerminal = entry;
    }
    expect(replacementTerminal).toBeTruthy();
    const replacementPath = path.join(skillsRoot("agent-a"), replacementTerminal!);
    const replacement = JSON.parse(await fs.readFile(replacementPath, "utf8"));
    const activeReplacement = replacementPath.replace(".skill-committed-transaction-", ".skill-transaction-");
    await fs.rename(replacementPath, activeReplacement);
    await fs.rm(path.join(skillsRoot("agent-a"), replacement.backupName), { recursive: true });
    await expect(service.overview("agent-a"))
      .rejects.toMatchObject({ code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });

    const serviceB = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    await serviceB.installSkill({ agentId: "agent-b", archive: skillZip("Version A") });
    await serviceB.uninstallSkill({ agentId: "agent-b", skillId: "test-skill" });
    const removalTerminal = (await fs.readdir(skillsRoot("agent-b")))
      .find((entry) => entry.startsWith(".skill-committed-remove-transaction-"));
    expect(removalTerminal).toBeTruthy();
    const removalPath = path.join(skillsRoot("agent-b"), removalTerminal!);
    const removal = JSON.parse(await fs.readFile(removalPath, "utf8"));
    await fs.rename(removalPath, removalPath.replace(".skill-committed-remove-transaction-", ".skill-remove-transaction-"));
    await fs.rm(path.join(skillsRoot("agent-b"), removal.backupName), { recursive: true });
    await expect(serviceB.overview("agent-b"))
      .rejects.toMatchObject({ code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });
  }, 15_000);

  it("keeps recovery bound to the entry-pinned skills inode after the visible directory is replaced", async () => {
    const setup = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    await setup.installSkill({ agentId: "agent-a", archive: skillZip("Pinned recovery") });
    const skills = skillsRoot("agent-a");
    const terminalName = (await fs.readdir(skills))
      .find((entry) => entry.startsWith(".skill-committed-transaction-"));
    expect(terminalName).toBeTruthy();
    const activeName = terminalName!.replace(".skill-committed-transaction-", ".skill-transaction-");
    await fs.rename(path.join(skills, terminalName!), path.join(skills, activeName));

    const replacementParent = await privateTemporaryDirectory();
    const replacement = path.join(replacementParent, "replacement");
    await fs.cp(skills, replacement, { recursive: true, preserveTimestamps: true });
    await fs.chmod(replacement, 0o700);
    const originalIdentity = await fs.lstat(skills, { bigint: true });
    const replacementIdentity = await fs.lstat(replacement, { bigint: true });
    const replacementBefore = await fileTreeManifest(replacement);
    const movedOriginal = `${skills}-original`;
    const outside = await privateTemporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "unchanged\n", { mode: 0o600 });
    let swapped = false;
    const racingStore = new AgentExtensionStore({
      workspaceRoot: workspace,
      async faultInjector(step) {
        if (swapped || step !== "before-skill-recovery-mutation") return;
        swapped = true;
        await fs.rename(skills, movedOriginal);
        await fs.rename(replacement, skills);
      }
    });
    await expect(racingStore.readSkillIndex("agent-a"))
      .rejects.toMatchObject({ code: expect.stringMatching(/(?:PATH_CHANGED|TRANSACTION_RECOVERY_REQUIRED)/u) });
    expect(swapped).toBe(true);
    const [movedIdentity, visibleIdentity] = await Promise.all([
      fs.lstat(movedOriginal, { bigint: true }),
      fs.lstat(skills, { bigint: true })
    ]);
    expect({ dev: movedIdentity.dev, ino: movedIdentity.ino, mode: movedIdentity.mode & 0o777n })
      .toEqual({ dev: originalIdentity.dev, ino: originalIdentity.ino, mode: 0o700n });
    expect({ dev: visibleIdentity.dev, ino: visibleIdentity.ino, mode: visibleIdentity.mode & 0o777n })
      .toEqual({ dev: replacementIdentity.dev, ino: replacementIdentity.ino, mode: 0o700n });
    expect(await fileTreeManifest(skills)).toEqual(replacementBefore);
    expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
  });

  it.each(["extensions", "skills", "mcp"])("rejects an existing %s controlled directory with group permissions before writing", async (directory) => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    await store.ensureLayout("agent-a");
    const target = directory === "extensions"
      ? path.dirname(skillsRoot("agent-a"))
      : directory === "skills"
        ? skillsRoot("agent-a")
        : path.dirname(mcpIndex("agent-a"));
    const beforeIndex = await fs.readFile(skillIndex("agent-a"));
    const beforeEntries = (await fs.readdir(target)).sort();
    await fs.chmod(target, 0o770);
    await expect(store.ensureLayout("agent-a"))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_PATH_INVALID" });
    expect(await fs.readFile(skillIndex("agent-a"))).toEqual(beforeIndex);
    expect((await fs.readdir(target)).sort()).toEqual(beforeEntries);
  });

  it("rolls back a pre-commit publish failure and leaves durable recovery evidence", async () => {
    const initial = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    const record = await initial.installSkill({ agentId: "agent-a", archive: skillZip("Original behavior") });
    const faulty = new AgentExtensionService(new AgentExtensionStore({
      workspaceRoot: workspace,
      faultInjector(step) {
        if (step === "after-skill-directory-publish") {
          throw Object.assign(new Error("injected"), { code: "INJECTED_FAILURE" });
        }
      }
    }));
    await expect(faulty.installSkill({
      agentId: "agent-a",
      archive: skillZip("Uncommitted behavior"),
      replace: true
    })).rejects.toMatchObject({ code: "INJECTED_FAILURE" });
    expect((await initial.overview("agent-a")).skills[0]?.digestSha256).toBe(record.digestSha256);
    expect(await fs.readFile(path.join(skillsRoot("agent-a"), "test-skill/SKILL.md"), "utf8"))
      .toContain("Original behavior");
    const entries = await fs.readdir(skillsRoot("agent-a"));
    expect(entries.some((entry) => entry.startsWith(".skill-rolled_back-transaction-"))).toBe(true);
    expect(entries.some((entry) => entry.startsWith(".skill-quarantine-"))).toBe(true);
  });

  it("recovers interruption immediately after publish and uninstall renames", async () => {
    const publishStore = new AgentExtensionStore({
      workspaceRoot: workspace,
      faultInjector(step) {
        if (step === "after-skill-target-rename") {
          throw Object.assign(new Error("injected publish rename"), { code: "INJECTED_PUBLISH_RENAME" });
        }
      }
    });
    await expect(publishStore.installSkill({
      agentId: "agent-a",
      archive: skillZip("Publish interruption"),
      replace: false
    })).rejects.toMatchObject({ code: "INJECTED_PUBLISH_RENAME" });
    const recovered = new AgentExtensionStore({ workspaceRoot: workspace });
    await expect(recovered.readSkillIndex("agent-a")).resolves.toMatchObject({ skills: [] });
    expect((await fs.readdir(skillsRoot("agent-a"))).some((entry) => entry.startsWith(".skill-quarantine-")))
      .toBe(true);

    const service = new AgentExtensionService(recovered);
    await service.installSkill({ agentId: "agent-b", archive: skillZip("Installed") });
    const removeStore = new AgentExtensionStore({
      workspaceRoot: workspace,
      faultInjector(step) {
        if (step === "after-skill-remove-rename") {
          throw Object.assign(new Error("injected remove rename"), { code: "INJECTED_REMOVE_RENAME" });
        }
      }
    });
    await expect(removeStore.uninstallSkill({ agentId: "agent-b", skillId: "test-skill" }))
      .rejects.toMatchObject({ code: "INJECTED_REMOVE_RENAME" });
    await expect(recovered.readSkillIndex("agent-b")).resolves.toMatchObject({
      skills: [expect.objectContaining({ id: "test-skill" })]
    });
    expect(await fs.readFile(path.join(skillsRoot("agent-b"), "test-skill/SKILL.md"), "utf8"))
      .toContain("Installed");
  }, 20_000);

  it("terminalizes a removal rollback before a later replacement and ignores damaged historical audit evidence", async () => {
    const initial = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    const first = await initial.installSkill({ agentId: "agent-a", archive: skillZip("Version A") });
    const committedAudit = (await fs.readdir(skillsRoot("agent-a")))
      .find((entry) => entry.startsWith(".skill-committed-transaction-"));
    expect(committedAudit).toBeTruthy();
    await fs.writeFile(path.join(skillsRoot("agent-a"), committedAudit!), "damaged committed audit\n", { mode: 0o600 });
    const faulty = new AgentExtensionService(new AgentExtensionStore({
      workspaceRoot: workspace,
      faultInjector(step) {
        if (step === "after-skill-remove-rename") {
          throw Object.assign(new Error("remove rename fault"), { code: "INJECTED_REMOVE_RENAME" });
        }
      }
    }));
    await expect(faulty.uninstallSkill({ agentId: "agent-a", skillId: first.id }))
      .rejects.toMatchObject({ code: "INJECTED_REMOVE_RENAME" });
    expect(await fs.readFile(path.join(skillsRoot("agent-a"), "test-skill/SKILL.md"), "utf8"))
      .toContain("Version A");
    const afterRollback = await fs.readdir(skillsRoot("agent-a"));
    const rolledBackAudit = afterRollback.find((entry) => entry.startsWith(".skill-rolled_back-remove-transaction-"));
    expect(rolledBackAudit).toBeTruthy();
    await fs.writeFile(path.join(skillsRoot("agent-a"), rolledBackAudit!), "damaged historical audit\n", { mode: 0o600 });

    const replacement = await initial.installSkill({
      agentId: "agent-a",
      archive: skillZip("Version B"),
      replace: true
    });
    const overview = await initial.overview("agent-a");
    expect(overview.skills).toEqual([expect.objectContaining({
      id: "test-skill",
      digestSha256: replacement.digestSha256
    })]);
    expect(await fs.readFile(path.join(skillsRoot("agent-a"), "test-skill/SKILL.md"), "utf8"))
      .toContain("Version B");
  });

  it("retains every artifact when a post-publish rename hook injects an unknown destination", async () => {
    const initial = new AgentExtensionService(new AgentExtensionStore({ workspaceRoot: workspace }));
    const record = await initial.installSkill({ agentId: "agent-a", archive: skillZip("Original behavior") });
    const outside = await privateTemporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "unchanged\n");
    const target = path.join(skillsRoot("agent-a"), "test-skill");
    const movedTarget = path.join(skillsRoot("agent-a"), ".attacker-retained-target");
    let attacked = false;
    const faulty = new AgentExtensionStore({
      workspaceRoot: workspace,
      async faultInjector(step) {
        if (attacked || step !== "after-skill-target-rename") return;
        attacked = true;
        await fs.rename(target, movedTarget);
        await fs.symlink(outside, target);
      }
    });
    await expect(faulty.installSkill({
      agentId: "agent-a",
      archive: skillZip("Replacement behavior"),
      replace: true
    })).rejects.toMatchObject({
      code: expect.stringMatching(/(?:AGENT_EXTENSION_PATH_CHANGED|SKILL_PACKAGE_CHANGED|SKILL_TRANSACTION_INVALID)/u)
    });
    expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
    expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(movedTarget)).isDirectory()).toBe(true);
    const rawIndex = JSON.parse(await fs.readFile(skillIndex("agent-a"), "utf8"));
    expect(rawIndex.skills[0].digestSha256).toBe(record.digestSha256);
    const entries = await fs.readdir(skillsRoot("agent-a"));
    expect(entries.some((entry) => entry.startsWith(".skill-transaction-"))).toBe(true);
    expect(entries.some((entry) => entry.startsWith(".skill-quarantine-test-skill-"))).toBe(true);
    await expect(faulty.readSkillIndex("agent-a")).rejects.toMatchObject({
      code: expect.stringMatching(/(?:SKILL_(?:PACKAGE_CHANGED|TRANSACTION_INVALID)|AGENT_EXTENSION_PATH_CHANGED)/u)
    });
  });

  it.each(["before", "after", "after-swap-back"])("fails closed for %s rename identity races without unknown writes", async (phase) => {
    const root = await privateTemporaryDirectory();
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const outside = await privateTemporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.mkdir(source, { mode: 0o700 });
    await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown());
    await fs.writeFile(sentinel, "unchanged\n");
    const digest = (await inspectSkillDirectory(source)).digestSha256;
    let moved = "";
    const swapSourceBack = async () => {
      moved = path.join(root, "source-moved");
      await fs.rename(source, moved);
      await fs.mkdir(source, { mode: 0o700 });
      await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown("other-skill"));
      await fs.rm(source, { recursive: true });
      await fs.rename(moved, source);
      moved = "";
    };
    const swapDestination = async (swapBack: boolean) => {
      moved = path.join(root, "destination-moved");
      await fs.rename(destination, moved);
      await fs.symlink(outside, destination);
      if (swapBack) {
        await fs.unlink(destination);
        await fs.rename(moved, destination);
        moved = "";
      }
    };
    await expect(moveVerifiedSkillDirectory({
      source,
      destination,
      expectedDigest: digest,
      hooks: {
        beforeRename: phase === "before" ? swapSourceBack : undefined,
        afterRename: phase === "after" ? () => swapDestination(false) :
          phase === "after-swap-back" ? () => swapDestination(true) : undefined
      }
    })).rejects.toMatchObject({
      code: expect.stringMatching(/(?:SKILL_(?:PACKAGE_CHANGED|TRANSACTION_INVALID)|AGENT_EXTENSION_PATH_CHANGED)/u)
    });
    expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
    expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
    if (phase === "before") {
      expect(await exists(destination)).toBe(false);
      expect(await exists(source)).toBe(true);
    } else {
      expect(await exists(source)).toBe(false);
      expect(await exists(destination)).toBe(true);
      expect(moved === "" || await exists(moved)).toBe(true);
    }
  });

  it("binds the final Skill rename to the original parent inode when its visible path is swapped after worker readiness", async () => {
    const root = await privateTemporaryDirectory();
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const outside = await privateTemporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.mkdir(source, { mode: 0o700 });
    await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown());
    await fs.writeFile(sentinel, "unchanged\n");
    const digest = (await inspectSkillDirectory(source)).digestSha256;
    const movedRoot = `${root}-bound-moved`;
    try {
      await expect(moveVerifiedSkillDirectory({
        source,
        destination,
        expectedDigest: digest,
        hooks: {
          async beforeBoundRename() {
            await fs.rename(root, movedRoot);
            await fs.symlink(outside, root);
          }
        }
      })).rejects.toMatchObject({ code: "AGENT_EXTENSION_PATH_CHANGED" });
      expect((await fs.lstat(path.join(movedRoot, "destination"))).isDirectory()).toBe(true);
      await expect(fs.access(path.join(movedRoot, "source"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
      expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
    } finally {
      if (await exists(root) && (await fs.lstat(root)).isSymbolicLink()) await fs.unlink(root);
      if (await exists(movedRoot)) await fs.rename(movedRoot, root);
    }
  });

  it("detects content changes before preview and refuses index, hardlink, and symlink tampering", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const service = new AgentExtensionService(store);
    await service.installSkill({ agentId: "agent-a", archive: skillZip("Original behavior") });
    const skillFile = path.join(skillsRoot("agent-a"), "test-skill/SKILL.md");
    await fs.writeFile(skillFile, skillMarkdown("test-skill", undefined, "Changed after install"));
    await expect(service.previewCopy({
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
      skillId: "test-skill"
    })).rejects.toMatchObject({ code: expect.stringMatching(/SKILL_(?:SOURCE_CHANGED|PACKAGE_CHANGED|INDEX_MISMATCH)/u) });
    await expect(store.readSkillIndex("agent-a")).rejects.toMatchObject({
      code: expect.stringMatching(/SKILL_(?:INDEX_MISMATCH|PACKAGE_CHANGED)/u)
    });

    await fs.writeFile(skillFile, skillMarkdown("test-skill", undefined, "Original behavior"));
    await fs.link(skillFile, path.join(skillsRoot("agent-a"), "test-skill/linked.md"));
    await expect(store.readSkillIndex("agent-a")).rejects.toMatchObject({
      code: expect.stringMatching(/SKILL_(?:INDEX_MISMATCH|PACKAGE_SPECIAL_FILE_REJECTED)/u)
    });
  });

  it("rejects traversal, extension-parent symlinks, and same-size index replacement races without outside writes", async () => {
    const store = new AgentExtensionStore({ workspaceRoot: workspace });
    const outside = await privateTemporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "unchanged\n");
    await expect(store.ensureLayout("../../outside"))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_AGENT_ID_INVALID" });
    const extensions = path.join(workspace, "business/agents/agent-b/extensions");
    await fs.symlink(outside, extensions);
    await expect(store.ensureLayout("agent-b")).rejects.toMatchObject({ code: "AGENT_EXTENSION_PATH_INVALID" });
    expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);

    await store.ensureLayout("agent-a");
    const target = await fs.realpath(skillIndex("agent-a"));
    let replaced = false;
    const racingStore = new AgentExtensionStore({
      workspaceRoot: workspace,
      async beforeFileOpen(filePath) {
        if (replaced || filePath !== target) return;
        replaced = true;
        const content = await fs.readFile(target);
        await fs.rename(target, `${target}.old`);
        const changed = Buffer.from(content);
        changed[0] = changed[0] === 0x7b ? 0x20 : 0x7b;
        await fs.writeFile(target, changed, { mode: 0o600 });
      }
    });
    await expect(racingStore.readSkillIndex("agent-a"))
      .rejects.toMatchObject({ code: "AGENT_EXTENSION_FILE_CHANGED" });
  });
});

function skillZip(body: string) {
  return makeStoredZip([{ name: "SKILL.md", content: skillMarkdown("test-skill", undefined, body) }]);
}

function fullSkillZip(body: string) {
  return makeStoredZip([
    {
      name: "SKILL.md",
      content: skillMarkdown(
        "test-skill",
        undefined,
        `${body}\nRead https://docs.example.test and references/usage.md.`,
        "license: MIT\ncompatibility: Requires git.\nmetadata:\n  author: Sunabot\nallowed-tools: Read write_file Bash(git:*)"
      )
    },
    { name: "references/usage.md", content: "Usage details.\n" },
    { name: "scripts/run.sh", content: "#!/bin/sh\n" },
    { name: "agents/openai.yaml", content: openAiSkillMetadata() }
  ]);
}

function mcpDescriptor() {
  return {
    id: "github-mcp",
    name: "GitHub MCP",
    description: "Provides repository tools.",
    enabled: true,
    transport: "stdio" as const,
    command: "/usr/bin/github-mcp",
    args: ["--stdio"],
    envKeys: ["GITHUB_TOKEN"]
  };
}

function httpMcpDescriptor(
  id: string,
  auth: { kind: "bearer" | "oauth"; credentialRef: string }
) {
  return {
    id,
    name: id,
    description: "Remote MCP.",
    enabled: true,
    required: true,
    enabledTools: [],
    disabledTools: [],
    approvalMode: "always" as const,
    transport: "streamable_http" as const,
    url: `https://extensions.example.test/${id === "oauth-mcp" ? "two" : "one"}`,
    auth
  };
}

function skillsRoot(agentId: string) {
  return path.join(workspace, `business/agents/${agentId}/extensions/skills`);
}

function skillIndex(agentId: string) {
  return path.join(skillsRoot(agentId), "index.json");
}

function mcpIndex(agentId: string) {
  return path.join(workspace, `business/agents/${agentId}/extensions/mcp/servers.json`);
}

async function extensionFileContents(agentId: string) {
  const root = path.join(workspace, `business/agents/${agentId}/extensions`);
  const entries = await fs.readdir(root, { recursive: true });
  const contents: string[] = [];
  for (const relative of entries) {
    const candidate = path.join(root, relative);
    if ((await fs.lstat(candidate)).isFile()) contents.push(await fs.readFile(candidate, "utf8"));
  }
  return contents.join("\n");
}

async function fileTreeManifest(root: string) {
  const entries = (await fs.readdir(root, { recursive: true })).sort();
  const manifest: Array<{ path: string; kind: "directory" | "file"; mode: number; content?: string }> = [];
  for (const relative of entries) {
    const candidate = path.join(root, relative);
    const stat = await fs.lstat(candidate);
    manifest.push(stat.isDirectory()
      ? { path: relative, kind: "directory", mode: stat.mode & 0o777 }
      : {
          path: relative,
          kind: "file",
          mode: stat.mode & 0o777,
          content: (await fs.readFile(candidate)).toString("base64")
        });
  }
  return manifest;
}

async function privateTemporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-extension-private-"));
  temporaryPaths.push(directory);
  await fs.chmod(directory, 0o700);
  return fs.realpath(directory);
}

async function exists(candidate: string) {
  try { await fs.lstat(candidate); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
