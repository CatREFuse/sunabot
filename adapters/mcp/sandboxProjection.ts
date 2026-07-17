import { createHash } from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { isRuntimeApprovedSkill } from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import type {
  AgentMcpServerDescriptor,
  AgentMcpServerIndex,
  AgentSkillIndex
} from "../../packages/contracts/extensions/agentExtensions.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { resolveAgentWorkbench } from "../../services/agents/public.js";
import { AgentExtensionPathGuard } from "../filesystem/agentExtensionPaths.js";
import { buildSkillCopyArchive } from "../filesystem/agentSkillCopyArchive.js";
import { extractSkillArchive, inspectSkillDirectory } from "../filesystem/skillArchive.js";
import { mcpStdioEntrypointSource } from "./stdioEntrypointSource.js";
import {
  MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256,
  readMcpApprovedExecutableManifest
} from "./approvedExecutableManifest.js";
import {
  captureIdentityBoundSecretDirectory,
  quarantineWipeAndRemove,
  wipeMcpLaunchSecretTree,
  type IdentityBoundSecretDirectory
} from "./secretProjectionCleanup.js";

export interface McpSandboxProjectionRepository {
  readSkillIndex(agentId: string): Promise<AgentSkillIndex>;
  readMcpServerIndex(agentId: string): Promise<AgentMcpServerIndex>;
}

export interface McpSandboxProjection {
  root: string;
  workbench: string;
  skills: string;
  config: string;
  launchSecrets?: string;
  stdioEntrypoint?: string;
  stdioNodeExecutable?: "/usr/bin/node" | "/usr/local/bin/node";
  executableManifest?: string;
  digestSha256: string;
  dispose(): Promise<void>;
}

export class McpSandboxProjectionBuilder {
  private readonly pathGuard: AgentExtensionPathGuard;
  private readonly buildQueues = new Map<string, Promise<unknown>>();
  private cleanup?: Promise<void>;

  constructor(private readonly options: {
    workspaceRoot: string;
    repository: McpSandboxProjectionRepository;
    temporaryRoot?: string;
    executableManifestPath?: string;
    executableManifestUid?: number;
    executableManifestSha256?: string;
    nodeExecutable?: "/usr/bin/node" | "/usr/local/bin/node";
  }) {
    this.pathGuard = new AgentExtensionPathGuard(options.workspaceRoot, {});
  }

  async build(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
  }): Promise<McpSandboxProjection> {
    const previous = this.buildQueues.get(input.agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.buildAgentProjection(input));
    this.buildQueues.set(input.agentId, current);
    return current.finally(() => {
      if (this.buildQueues.get(input.agentId) === current) this.buildQueues.delete(input.agentId);
    });
  }

  private async buildAgentProjection(input: {
    agentId: string;
    server: AgentMcpServerDescriptor;
  }): Promise<McpSandboxProjection> {
    const temporaryRoot = await fs.realpath(path.resolve(this.options.temporaryRoot ?? os.tmpdir()))
      .catch(() => projectionInvalid());
    this.cleanup ??= garbageCollectMcpSandboxProjections(temporaryRoot);
    await this.cleanup;
    const workbench = await resolveAgentWorkbench(path.join(
      path.resolve(this.options.workspaceRoot),
      WORKSPACE_LAYOUT.agentRoot,
      input.agentId
    ));
    const [skillIndex, mcpIndex] = await Promise.all([
      this.options.repository.readSkillIndex(input.agentId),
      this.options.repository.readMcpServerIndex(input.agentId)
    ]);
    const paths = await this.pathGuard.paths(input.agentId);
    await this.pathGuard.guard(paths, "mcp-projection-start");
    const configured = mcpIndex.servers.find((server) => server.id === input.server.id);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(input.server)) projectionInvalid();
    const root = await fs.mkdtemp(path.join(
      temporaryRoot,
      `sunabot-mcp-${process.pid}-${input.agentId}-${input.server.id}-`
    ));
    await fs.chmod(root, 0o700);
    const cleanupIdentity = await captureIdentityBoundSecretDirectory(root);
    const skills = path.join(root, "skills");
    const configDirectory = path.join(root, "extensions");
    const config = path.join(configDirectory, "mcp.json");
    const launchSecrets = path.join(root, "launch-secrets");
    const runtimeDirectory = path.join(root, "runtime");
    const stdioEntrypoint = path.join(runtimeDirectory, "mcp-stdio-entrypoint");
    const executableManifest = path.join(runtimeDirectory, "mcp-executables.json");
    const stdioNodeExecutable = this.options.nodeExecutable ?? "/usr/bin/node";
    try {
      await fs.mkdir(skills, { mode: 0o700 });
      await fs.mkdir(configDirectory, { mode: 0o700 });
      await fs.mkdir(launchSecrets, { mode: 0o700 });
      await fs.mkdir(runtimeDirectory, { mode: 0o700 });
      await fs.writeFile(stdioEntrypoint, mcpStdioEntrypointSource(stdioNodeExecutable), {
        encoding: "utf8",
        mode: 0o500,
        flag: "wx"
      });
      if (this.options.executableManifestPath && this.options.executableManifestSha256) projectionInvalid();
      if (this.options.executableManifestSha256 &&
          !/^[a-f0-9]{64}$/u.test(this.options.executableManifestSha256)) projectionInvalid();
      let executableManifestSha256 = this.options.executableManifestSha256 ??
        MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256;
      if (this.options.executableManifestPath) {
        const loaded = await readMcpApprovedExecutableManifest(this.options.executableManifestPath, {
          ...(this.options.executableManifestUid === undefined
            ? {}
            : { expectedUid: this.options.executableManifestUid })
        });
        try {
          executableManifestSha256 = createHash("sha256").update(loaded.encoded).digest("hex");
          await fs.writeFile(executableManifest, loaded.encoded, { mode: 0o444, flag: "wx" });
        } finally {
          loaded.encoded.fill(0);
        }
      }
      const approved = skillIndex.skills.filter(isRuntimeApprovedSkill);
      for (const record of approved) {
        const source = path.join(paths.skills, record.id);
        const archive = await buildSkillCopyArchive({
          directory: source,
          expectedDigestSha256: record.digestSha256
        });
        const extracted = await extractSkillArchive({ archive, stagingRoot: skills });
        if (extracted.evidence.digestSha256 !== record.digestSha256 || extracted.evidence.name !== record.name) {
          projectionInvalid();
        }
        const target = path.join(skills, record.id);
        await fs.rename(extracted.packageRoot, target);
        const copied = await inspectSkillDirectory(target);
        if (copied.digestSha256 !== record.digestSha256) projectionInvalid();
      }
      const snapshot = {
        schemaVersion: 1,
        agentId: input.agentId,
        virtualRoots: { workbench: "/workbench", skills: "/skills" },
        executableManifestSha256,
        skills: approved.map((skill) => ({ id: skill.id, digestSha256: skill.digestSha256 })),
        server: sanitizeServer(configured)
      };
      const encoded = `${JSON.stringify(snapshot)}\n`;
      await fs.writeFile(config, encoded, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await this.pathGuard.guard(paths, "mcp-projection-finish");
      const digestSha256 = createHash("sha256").update(encoded).digest("hex");
      await makeReadOnly(skills);
      await fs.chmod(configDirectory, 0o500);
      await fs.chmod(runtimeDirectory, 0o500);
      await fs.chmod(root, 0o500);
      let disposed = false;
      let cleanup: Promise<void> | undefined;
      return {
        root,
        workbench,
        skills,
        config,
        launchSecrets,
        stdioEntrypoint,
        stdioNodeExecutable,
        ...(this.options.executableManifestPath ? { executableManifest } : {}),
        digestSha256,
        async dispose() {
          if (disposed) return;
          cleanup ??= removeProjection(cleanupIdentity).then(() => {
            disposed = true;
          }).catch((error) => {
            cleanup = undefined;
            throw error;
          });
          await cleanup;
        }
      };
    } catch (error) {
      await removeProjection(cleanupIdentity);
      throw error;
    }
  }
}

export async function garbageCollectMcpSandboxProjections(
  temporaryRoot: string,
  options: { now?: number; uid?: number } = {}
) {
  temporaryRoot = await fs.realpath(path.resolve(temporaryRoot)).catch(() => projectionInvalid());
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const entries = await readdirIfPresent(temporaryRoot);
  for (const entry of entries) {
    const match = /^\.?(sunabot-mcp-(\d+)-[a-z][a-z0-9-]{1,31}-[a-z0-9]+(?:-[a-z0-9]+)*-[A-Za-z0-9_-]+)(?:\.cleanup-[a-f0-9]{32})?$/u.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const candidate = path.join(temporaryRoot, entry.name);
    const stat = await lstatIfPresent(candidate);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) ||
        processAlive(Number(match[2]))) {
      continue;
    }
    const sourcePath = path.join(temporaryRoot, match[1]!);
    await removeProjection(await captureIdentityBoundSecretDirectory(candidate, sourcePath));
  }
}

async function readdirIfPresent(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function lstatIfPresent(candidate: string) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sanitizeServer(server: AgentMcpServerDescriptor) {
  const policy = {
    id: server.id,
    enabled: server.enabled,
    required: server.required ?? false,
    enabledTools: server.enabledTools ?? [],
    disabledTools: server.disabledTools ?? [],
    approvalMode: server.approvalMode ?? "always"
  };
  return server.transport === "stdio"
    ? { ...policy, transport: server.transport, command: server.command, args: server.args, envKeys: server.envKeys }
    : { ...policy, transport: server.transport, url: server.url, auth: server.auth };
}

async function makeReadOnly(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(target);
      await fs.chmod(target, 0o500);
    } else {
      await fs.chmod(target, 0o400);
    }
  }
  await fs.chmod(root, 0o500);
}

async function removeProjection(identity: IdentityBoundSecretDirectory) {
  try {
    await quarantineWipeAndRemove(identity, wipeMcpLaunchSecretTree);
  } catch (error) {
    throw stableSecretCleanupError(error);
  }
}

function stableSecretCleanupError(_error: unknown) {
  const error = new Error("MCP_STDIO_SECRET_CLEANUP_FAILED");
  error.name = "McpAdapterError";
  return error;
}

function projectionInvalid(): never {
  throw new Error("MCP_SANDBOX_PROJECTION_INVALID");
}
