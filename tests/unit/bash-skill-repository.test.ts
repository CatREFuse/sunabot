// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashApprovalContext, BashAuditResult } from "../../services/tools/bashAudit.js";
import {
  BashSkillRepositoryCommandError,
  parseBashSkillRepositoryCommand,
  type BashSkillRepositoryPort,
  type BashSkillRepositoryRecord
} from "../../services/tools/bashSkillRepository.js";
import { runWorkspaceBash } from "../../services/tools/bashTool.js";

const secureScratchParent = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("managed Bash Skill repository command", () => {
  it("parses only the documented single-command forms", () => {
    expect(parseBashSkillRepositoryCommand("sunabot-skill install --archive packages/demo.zip")).toEqual({
      operation: "install",
      archivePath: "packages/demo.zip",
      replace: false
    });
    expect(parseBashSkillRepositoryCommand("sunabot-skill install --replace --archive demo.zip")).toEqual({
      operation: "install",
      archivePath: "demo.zip",
      replace: true
    });
    expect(parseBashSkillRepositoryCommand("sunabot-skill review --skill demo-skill --approve")).toEqual({
      operation: "review",
      skillId: "demo-skill"
    });
    expect(parseBashSkillRepositoryCommand("pwd")).toBeUndefined();
    expect(() => parseBashSkillRepositoryCommand("sunabot-skill install --archive ../demo.zip"))
      .toThrow(BashSkillRepositoryCommandError);
    expect(() => parseBashSkillRepositoryCommand("sunabot-skill status --skill demo; pwd"))
      .toThrow(BashSkillRepositoryCommandError);
  });

  it("reads a frozen Native workbench ZIP and delegates installation without spawning a shell", async () => {
    const workspace = await makeWorkspace("install");
    const archive = Buffer.from("fixture zip bytes");
    await fs.writeFile(path.join(workspace, "workbench", "demo.zip"), archive, { mode: 0o600 });
    const repository = mockRepository();

    const result = await runWorkspaceBash(
      { command: "sunabot-skill install --archive demo.zip" },
      workspace,
      {
        backend: "native",
        accessMode: "admin",
        isAdmin: true,
        audit: async () => allowedAudit(),
        approvalContext: approvalContext("native"),
        skillRepository: repository
      }
    );

    expect(result).toMatchObject({ ok: true, exitCode: 0, backend: "native" });
    expect(JSON.parse(result.stdout)).toMatchObject({ skillId: "demo-skill", status: "待审查" });
    expect(repository.install).toHaveBeenCalledWith({
      agentId: "plana",
      archive,
      replace: false
    });
  });

  it("rejects the managed command outside Native administrator Bash before repository access", async () => {
    const workspace = await makeWorkspace("docker-reject");
    const repository = mockRepository();
    const audit = vi.fn(async () => allowedAudit());

    const result = await runWorkspaceBash(
      { command: "sunabot-skill status --skill demo-skill" },
      workspace,
      {
        backend: "docker",
        accessMode: "isolated",
        isAdmin: true,
        audit,
        approvalContext: approvalContext("docker"),
        skillRepository: repository
      }
    );

    expect(result.stderr).toContain("BASH_SKILL_REPOSITORY_NATIVE_ADMIN_REQUIRED");
    expect(audit).not.toHaveBeenCalled();
    expect(repository.status).not.toHaveBeenCalled();
  });

  it("rejects a symlinked archive before repository access", async () => {
    const workspace = await makeWorkspace("symlink-reject");
    const workbench = path.join(workspace, "workbench");
    await fs.writeFile(path.join(workbench, "real.zip"), "fixture", { mode: 0o600 });
    await fs.symlink("real.zip", path.join(workbench, "linked.zip"));
    const repository = mockRepository();

    const result = await runWorkspaceBash(
      { command: "sunabot-skill install --archive linked.zip" },
      workspace,
      {
        backend: "native",
        accessMode: "admin",
        isAdmin: true,
        audit: async () => allowedAudit(),
        approvalContext: approvalContext("native"),
        skillRepository: repository
      }
    );

    expect(result.stderr).toContain("BASH_SKILL_ARCHIVE_INVALID");
    expect(repository.install).not.toHaveBeenCalled();
  });

  it("rejects hard-linked and oversized archives before repository access", async () => {
    const workspace = await makeWorkspace("archive-constraints");
    const workbench = path.join(workspace, "workbench");
    const repository = mockRepository();
    await fs.writeFile(path.join(workbench, "hardlinked.zip"), "fixture", { mode: 0o600 });
    await fs.link(path.join(workbench, "hardlinked.zip"), path.join(workbench, "second-link.zip"));
    await fs.writeFile(path.join(workbench, "oversized.zip"), "x", { mode: 0o600 });
    await fs.truncate(path.join(workbench, "oversized.zip"), (16 * 1024 * 1024) + 1);

    for (const archiveName of ["hardlinked.zip", "oversized.zip"]) {
      const result = await runWorkspaceBash(
        { command: `sunabot-skill install --archive ${archiveName}` },
        workspace,
        {
          backend: "native",
          accessMode: "admin",
          isAdmin: true,
          audit: async () => allowedAudit(),
          approvalContext: approvalContext("native"),
          skillRepository: repository
        }
      );
      expect(result.stderr).toContain("BASH_SKILL_ARCHIVE_INVALID");
    }
    expect(repository.install).not.toHaveBeenCalled();
  });

  it("rejects an archive whose metadata changes while its bytes are being read", async () => {
    const workspace = await makeWorkspace("archive-race");
    const archivePath = path.join(workspace, "workbench", "changing.zip");
    await fs.writeFile(archivePath, "fixture", { mode: 0o600 });
    const repository = mockRepository();
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "readFile") {
            return async (...readArgs: Parameters<typeof handle.readFile>) => {
              const bytes = await handle.readFile(...readArgs);
              const changed = new Date(Date.now() + 2_000);
              await fs.utimes(archivePath, changed, changed);
              return bytes;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    });

    try {
      const result = await runWorkspaceBash(
        { command: "sunabot-skill install --archive changing.zip" },
        workspace,
        {
          backend: "native",
          accessMode: "admin",
          isAdmin: true,
          audit: async () => allowedAudit(),
          approvalContext: approvalContext("native"),
          skillRepository: repository
        }
      );
      expect(result.stderr).toContain("BASH_SKILL_ARCHIVE_INVALID");
      expect(repository.install).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});

async function makeWorkspace(label: string) {
  const root = await fs.mkdtemp(path.join(secureScratchParent, `.bash-skill-${label}-`));
  temporaryRoots.push(root);
  await Promise.all([
    fs.mkdir(path.join(root, "workbench", "skills"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(root, "docker-workbench", "native-workbench"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(root, "extensions", "mcp"), { recursive: true, mode: 0o700 })
  ]);
  return root;
}

function approvalContext(backend: "native" | "docker"): BashApprovalContext {
  return {
    backend,
    agentId: "plana",
    accountId: "primary",
    transport: "onebot",
    conversationId: "account:primary:private:10001",
    userId: "10001"
  };
}

function mockRepository(): BashSkillRepositoryPort {
  const record: BashSkillRepositoryRecord = {
    skillId: "demo-skill",
    name: "demo-skill",
    digestSha256: "a".repeat(64),
    reviewStatus: "unreviewed",
    approvalStatus: "unapproved",
    enabled: false,
    status: "待审查"
  };
  return {
    install: vi.fn(async () => record),
    review: vi.fn(async () => ({
      ...record,
      reviewStatus: "approved",
      approvalStatus: "approved",
      status: "已批准，待启用"
    })),
    enable: vi.fn(async () => ({
      ...record,
      reviewStatus: "approved",
      approvalStatus: "approved",
      enabled: true,
      status: "已启用"
    })),
    status: vi.fn(async () => record)
  };
}

function allowedAudit(): BashAuditResult {
  return {
    decision: "allow",
    risk: "low",
    outsideWorkbench: false,
    outsideAccesses: [],
    violations: [],
    summary: "Managed current-workbench repository command."
  };
}
