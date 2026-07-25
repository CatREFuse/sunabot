import path from "node:path";
import { assertAgentId } from "../../packages/contracts/extensions/agentExtensions.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { AGENT_RESOURCE_LAYOUT } from "../../packages/platform/agentResourceLayout.js";
import {
  assertExistingChain,
  assertOptionalChain,
  lstatOptional,
  pinDirectoryIdentity,
  pinPrivateDirectoryIdentity,
  refreshPinnedDirectory,
  refreshPrivatePinnedDirectory,
  storeError,
  verifyPinnedDirectory,
  verifyPrivatePinnedDirectory,
  type PinnedDirectoryIdentity
} from "./agentExtensionSecureFs.js";

const SKILL_INDEX_FILE = "index.json";
const MCP_INDEX_FILE = "servers.json";

export interface AgentExtensionStorePaths {
  workspace: string;
  agent: string;
  skills: string;
  skillIndex: string;
  mcp: string;
  mcpIndex: string;
  workspaceIdentity: PinnedDirectoryIdentity;
  agentIdentity: PinnedDirectoryIdentity;
  controlledDirectories: ControlledDirectory[];
}

interface ControlledDirectory {
  path: string;
  identity: PinnedDirectoryIdentity | null;
}

export class AgentExtensionPathGuard {
  private readonly workspaceRoot: string;
  private workspaceIdentity?: PinnedDirectoryIdentity;

  constructor(
    workspaceRoot: string,
    private readonly hooks: {
      beforeWorkspaceRealpath?: () => void | Promise<void>;
      beforePathOperation?: (operation: string) => void | Promise<void>;
    }
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async paths(agentId: string): Promise<AgentExtensionStorePaths> {
    const safeAgentId = assertAgentId(agentId);
    const workspaceIdentity = await this.currentWorkspaceIdentity();
    const workspace = workspaceIdentity.realPath;
    const agent = path.join(workspace, WORKSPACE_LAYOUT.agentRoot, safeAgentId);
    const agentRoot = path.dirname(agent);
    await assertExistingChain(workspace, path.relative(workspace, agent));
    const agentIdentity = await pinPrivateDirectoryIdentity(agent, agent);
    const skills = path.join(agent, AGENT_RESOURCE_LAYOUT.skills);
    const extensions = path.join(agent, "extensions");
    const mcp = path.join(agent, AGENT_RESOURCE_LAYOUT.mcp);
    await assertOptionalChain(workspace, path.relative(workspace, skills));
    await assertOptionalChain(workspace, path.relative(workspace, mcp));
    const controlledDirectories = await Promise.all([
      agentRoot,
      path.join(agent, AGENT_RESOURCE_LAYOUT.workbench),
      extensions,
      skills,
      mcp
    ].map(async (directory) => ({
      path: directory,
      identity: await pinOptionalDirectory(directory)
    })));
    await verifyPinnedDirectory(this.workspaceRoot, workspaceIdentity);
    await verifyPrivatePinnedDirectory(agent, agentIdentity);
    return {
      workspace,
      agent,
      skills,
      skillIndex: path.join(skills, SKILL_INDEX_FILE),
      mcp,
      mcpIndex: path.join(mcp, MCP_INDEX_FILE),
      workspaceIdentity,
      agentIdentity,
      controlledDirectories
    };
  }

  async guard(paths: AgentExtensionStorePaths, operation: string) {
    await this.guardBase(paths, operation);
    await Promise.all(paths.controlledDirectories.map((directory) =>
      verifyOptionalDirectory(directory.path, directory.identity)
    ));
  }

  async guardBase(paths: AgentExtensionStorePaths, operation: string) {
    await this.hooks.beforePathOperation?.(operation);
    await verifyPinnedDirectory(this.workspaceRoot, paths.workspaceIdentity);
    await verifyPrivatePinnedDirectory(paths.agent, paths.agentIdentity);
  }

  async refresh(paths: AgentExtensionStorePaths, options: {
    allowCreated?: string[];
    allowChanged?: string[];
    allowWorkspaceChange?: boolean;
    allowAgentChange?: boolean;
  } = {}) {
    await this.refreshBase(paths, options);
    const allowedCreated = new Set(options.allowCreated ?? []);
    const allowedChanged = new Set(options.allowChanged ?? []);
    for (const directory of paths.controlledDirectories) {
      if (directory.identity) {
        directory.identity = allowedChanged.has(directory.path)
          ? await refreshPrivatePinnedDirectory(directory.path, directory.identity)
          : await verifyPrivatePinnedDirectory(directory.path, directory.identity);
        continue;
      }
      const current = await lstatOptional(directory.path);
      if (!current) continue;
      if (!allowedCreated.has(directory.path)) pathChanged();
      directory.identity = await pinPrivateDirectoryIdentity(directory.path, directory.path);
    }
  }

  async refreshBase(paths: AgentExtensionStorePaths, options: {
    allowWorkspaceChange?: boolean;
    allowAgentChange?: boolean;
  } = {}) {
    paths.workspaceIdentity = options.allowWorkspaceChange
      ? await refreshPinnedDirectory(this.workspaceRoot, paths.workspaceIdentity)
      : await verifyPinnedDirectory(this.workspaceRoot, paths.workspaceIdentity);
    this.workspaceIdentity = paths.workspaceIdentity;
    paths.agentIdentity = options.allowAgentChange
      ? await refreshPrivatePinnedDirectory(paths.agent, paths.agentIdentity)
      : await verifyPrivatePinnedDirectory(paths.agent, paths.agentIdentity);
  }

  controlledPaths(paths: AgentExtensionStorePaths) {
    return paths.controlledDirectories.map((directory) => directory.path);
  }

  isPinned(paths: AgentExtensionStorePaths, directory: string) {
    return paths.controlledDirectories.find((candidate) => candidate.path === directory)?.identity != null;
  }

  directoryIdentity(paths: AgentExtensionStorePaths, directory: string) {
    const identity = paths.controlledDirectories.find((candidate) => candidate.path === directory)?.identity;
    if (!identity) pathChanged();
    return { ...identity };
  }

  private async currentWorkspaceIdentity() {
    if (!this.workspaceIdentity) {
      this.workspaceIdentity = await pinDirectoryIdentity(
        this.workspaceRoot,
        undefined,
        this.hooks.beforeWorkspaceRealpath
      );
      return this.workspaceIdentity;
    }
    await verifyPinnedDirectory(this.workspaceRoot, this.workspaceIdentity);
    return this.workspaceIdentity;
  }
}

async function pinOptionalDirectory(directory: string) {
  return await lstatOptional(directory) ? pinPrivateDirectoryIdentity(directory, directory) : null;
}

async function verifyOptionalDirectory(directory: string, identity: PinnedDirectoryIdentity | null) {
  const current = await lstatOptional(directory);
  if (!identity) {
    if (current) pathChanged();
    return;
  }
  if (!current) pathChanged();
  await verifyPrivatePinnedDirectory(directory, identity);
}

function pathChanged(): never {
  throw storeError(409, "AGENT_EXTENSION_PATH_CHANGED", "Agent 扩展目录在操作期间发生变化。");
}
