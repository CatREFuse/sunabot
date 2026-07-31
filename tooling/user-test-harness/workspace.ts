import fs from "node:fs/promises";
import path from "node:path";
import { AgentExtensionStore } from "../../adapters/filesystem/agentExtensionStore.js";
import { BundledAgentSkillInstaller } from "../../apps/api/bundledAgentSkills.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import {
  assertCopiedCodexAuth,
  assertProviderRouteLockDocuments,
  prepareProviderSmokeWorkspace,
  resolveValidatedCodexHome
} from "../quality/prepare-runtime-smoke.mjs";

const MARKER_FILE = ".sunabot-user-test-workspace.json";
const AGENT_PERSONA_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "PREFERENCE.md",
  "DIALOGUE_STYLE_EXAMPLES.md",
  "USER.md",
  "RELATION.md",
  "DIRECTOR_SEED.md"
] as const;
const STANDARD_AGENT_PROMPT_FILES = [
  "conversation_reply.json",
  "conversation_private_reply.json",
  "conversation_group_reply.json",
  "tone_rewrite.json",
  "work_memory_compress_in.json",
  "work_memory_compress_out.json",
  "user_profile_prompt.json",
  "memory_dream.json",
  "user_groupchat_orchestrator.json",
  "group_thread_context.json",
  "group_chat_summary.json",
  "cron_callback.json",
  "director_daily_plan.json",
  "director_schedule_revision.json",
  "read_air.json",
  "selfie_prompt_rewrite.json"
] as const;
interface ProviderSmokeAgentCopyInput {
  source: string;
  destination: string;
  agentId: string;
  config: Record<string, unknown>;
}

export async function prepareUserTestWorkspace(input: {
  source: string;
  destination: string;
  confirmCredentialCopy: boolean;
  agentId?: string;
  providerId?: string;
  model?: string;
  lockProviderRoutes?: boolean;
  copyCodexAuth?: boolean;
}) {
  const prepared = await prepareProviderSmokeWorkspace({
    source: input.source,
    destination: input.destination,
    confirmCredentialCopy: input.confirmCredentialCopy,
    agentId: input.agentId,
    providerId: input.providerId,
    model: input.model,
    lockProviderRoutes: input.lockProviderRoutes,
    copyCodexAuth: input.copyCodexAuth,
    copyAgentWorkspace: (copy: ProviderSmokeAgentCopyInput) => (
      copySelectedAgentWorkspace(copy.source, copy.destination, copy.config)
    )
  });
  try {
    await preparePromptWorkspace(prepared.source, prepared.destination, prepared.configPath);
    await fs.chmod(path.join(prepared.destination, "business/agents"), 0o700);
    await isolateAgentWorkspace({
      workspace: prepared.destination,
      configPath: prepared.configPath,
      agentId: prepared.agentId
    });
    await new BundledAgentSkillInstaller(
      new AgentExtensionStore({ workspaceRoot: prepared.destination })
    ).ensure(prepared.agentId);
    if (input.lockProviderRoutes) {
      if (!prepared.routeLock) throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_MISSING");
      await assertProviderRouteLockDocuments({
        configPath: prepared.configPath,
        agentConfigPath: path.join(
          prepared.destination,
          "business/agents",
          prepared.agentId,
          "agent.json"
        ),
        envPath: prepared.envPath,
        ...prepared.routeLock
      });
      await resolveValidatedCodexHome(prepared.destination, {
        codexAuthCopied: prepared.codexAuthCopied
      });
    }
    if (prepared.codexAuthCopied) {
      await assertCopiedCodexAuth({
        source: prepared.source,
        destination: prepared.destination
      });
    }
    const marker = {
      schemaVersion: 1,
      purpose: "sunabot-user-test-harness",
      createdAt: new Date().toISOString(),
      sourceDigest: path.basename(path.resolve(input.source)),
      agentId: prepared.agentId,
      codexAuthCopied: prepared.codexAuthCopied,
      ...(prepared.routeLock ? {
        providerRouteLock: {
          providerId: prepared.routeLock.providerId,
          model: prepared.routeLock.model,
          providerApiKeyEnv: prepared.routeLock.providerApiKeyEnv,
          onebotAccessTokenEnv: prepared.routeLock.onebotAccessTokenEnv
        }
      } : {})
    };
    await fs.writeFile(
      path.join(prepared.destination, MARKER_FILE),
      `${JSON.stringify(marker, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    return prepared;
  } catch (error) {
    await fs.rm(prepared.destination, { recursive: true, force: true });
    throw error;
  }
}

export async function assertUserTestWorkspace(workspace: string) {
  if (!path.isAbsolute(workspace)) throw new Error("USER_TEST_WORKSPACE_NOT_ABSOLUTE");
  const resolvedWorkspace = path.resolve(workspace);
  const markerPath = path.join(resolvedWorkspace, MARKER_FILE);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
  if (marker.schemaVersion !== 1 || marker.purpose !== "sunabot-user-test-harness") {
    throw new Error("USER_TEST_WORKSPACE_MARKER_INVALID");
  }
  if (marker.providerRouteLock !== undefined) {
    const routeLock = marker.providerRouteLock;
    if (!isProviderRouteLockMarker(routeLock)) {
      throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_MARKER_INVALID");
    }
    const agentId = requiredMarkerAgentId(marker.agentId);
    await assertProviderRouteLockDocuments({
      configPath: path.join(resolvedWorkspace, "business/config/sunabot.json"),
      agentConfigPath: path.join(
        resolvedWorkspace,
        "business/agents",
        agentId,
        "agent.json"
      ),
      envPath: path.join(resolvedWorkspace, "secrets/runtime.env"),
      ...routeLock
    });
    await resolveValidatedCodexHome(resolvedWorkspace, {
      codexAuthCopied: marker.codexAuthCopied === true
    });
  }
  return resolvedWorkspace;
}

export async function installIsolatedCodexGuiHome(
  environment: NodeJS.ProcessEnv = process.env
) {
  const workspaceValue = String(environment.SUNABOT_WORKSPACE ?? "").trim();
  if (!workspaceValue) return () => undefined;
  if (!path.isAbsolute(workspaceValue)) {
    throw new Error("USER_TEST_WORKSPACE_NOT_ABSOLUTE");
  }
  const workspace = path.resolve(workspaceValue);
  const marker = JSON.parse(await fs.readFile(
    path.join(workspace, MARKER_FILE),
    "utf8"
  )) as Record<string, unknown>;
  const routeLock = marker.providerRouteLock;
  if (!isProviderRouteLockMarker(routeLock)) return () => undefined;
  const realWorkspace = await fs.realpath(workspace);
  const codexHome = await resolveValidatedCodexHome(workspace, {
    codexAuthCopied: marker.codexAuthCopied === true
  });
  const expectedCodexHome = path.join(realWorkspace, WORKSPACE_LAYOUT.codexHome);
  if (path.normalize(codexHome) !== path.normalize(expectedCodexHome)) {
    throw new Error("USER_TEST_CODEX_GUI_HOME_OUTSIDE_WORKSPACE");
  }
  const previousPresent = Object.prototype.hasOwnProperty.call(
    environment,
    "SUNABOT_CODEX_GUI_HOME"
  );
  const previousValue = environment.SUNABOT_CODEX_GUI_HOME;
  environment.SUNABOT_CODEX_GUI_HOME = codexHome;
  return () => {
    if (previousPresent) {
      environment.SUNABOT_CODEX_GUI_HOME = previousValue;
    } else {
      delete environment.SUNABOT_CODEX_GUI_HOME;
    }
  };
}

export function isProviderRouteLockMarker(value: unknown): value is {
  providerId: string;
  model: string;
  providerApiKeyEnv: string;
  onebotAccessTokenEnv: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.providerId === "string"
    && Boolean(record.providerId.trim())
    && typeof record.model === "string"
    && Boolean(record.model.trim())
    && typeof record.providerApiKeyEnv === "string"
    && Boolean(record.providerApiKeyEnv.trim())
    && typeof record.onebotAccessTokenEnv === "string"
    && Boolean(record.onebotAccessTokenEnv.trim());
}

function requiredMarkerAgentId(value: unknown) {
  const agentId = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)) {
    throw new Error("USER_TEST_WORKSPACE_MARKER_INVALID");
  }
  return agentId;
}

export async function resetUserTestKnowledgeDirectory(
  workspace: string,
  workbenchRoot: string
) {
  const isolatedWorkspace = await assertUserTestWorkspace(workspace);
  const [realWorkspace, realWorkbenchRoot] = await Promise.all([
    fs.realpath(isolatedWorkspace),
    fs.realpath(workbenchRoot)
  ]);
  assertInside(realWorkbenchRoot, realWorkspace, "USER_TEST_KNOWLEDGE_RESET_OUTSIDE_WORKSPACE");
  const knowledgeRoot = path.join(realWorkbenchRoot, "knowledge");
  try {
    const stats = await fs.lstat(knowledgeRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("USER_TEST_CONVERSATION_FIXTURE_KNOWLEDGE_DIRECTORY_INVALID");
    }
    await fs.rm(knowledgeRoot, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(knowledgeRoot, { mode: 0o700 });
}

export async function claimUserTestWorkspaceCase(input: {
  workspace: string;
  caseId: string;
  caseDigest: string;
}) {
  const workspace = await assertUserTestWorkspace(input.workspace);
  if (!/^[0-9a-f]{64}$/u.test(input.caseDigest)) {
    throw new Error("USER_TEST_CASE_DIGEST_INVALID");
  }
  const runsDirectory = path.join(workspace, ".sunabot-user-test-runs");
  try {
    await fs.mkdir(runsDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = await fs.lstat(runsDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("USER_TEST_WORKSPACE_RUNS_DIRECTORY_INVALID");
  }
  try {
    await fs.writeFile(
      path.join(runsDirectory, `${input.caseDigest}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        caseId: input.caseId,
        caseDigest: input.caseDigest,
        claimedAt: new Date().toISOString()
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("USER_TEST_WORKSPACE_CASE_ALREADY_RUN");
    }
    throw error;
  }
}

async function preparePromptWorkspace(
  sourceWorkspace: string,
  destinationWorkspace: string,
  destinationConfigPath: string
) {
  const config = JSON.parse(await fs.readFile(destinationConfigPath, "utf8")) as Record<string, unknown>;
  const persona = record(config.persona);
  const configured = typeof persona.systemPromptWorkspace === "string" &&
    persona.systemPromptWorkspace.trim()
    ? persona.systemPromptWorkspace.trim()
    : "workspace/business/prompts";
  const sourcePromptWorkspace = resolveWorkspaceReference(sourceWorkspace, configured);
  const destinationPromptWorkspace = path.join(destinationWorkspace, "business/prompts");
  const sourceExists = await fs.stat(sourcePromptWorkspace)
    .then((stats) => stats.isDirectory())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (sourceExists) {
    const [realSource, realWorkspace] = await Promise.all([
      fs.realpath(sourcePromptWorkspace),
      fs.realpath(sourceWorkspace)
    ]);
    assertInside(realSource, realWorkspace, "USER_TEST_PROMPT_WORKSPACE_OUTSIDE_SOURCE");
    await assertRegularDirectoryTree(realSource);
    await copyVisibleDirectoryTree(realSource, destinationPromptWorkspace);
  }
  config.persona = {
    ...persona,
    systemPromptWorkspace: "workspace/business/prompts"
  };
  await fs.writeFile(destinationConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

async function copyVisibleDirectoryTree(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyVisibleDirectoryTree(sourcePath, destinationPath);
      continue;
    }
    await fs.copyFile(sourcePath, destinationPath);
    await fs.chmod(destinationPath, 0o600);
  }
}

async function copySelectedAgentWorkspace(
  source: string,
  destination: string,
  config: Record<string, unknown>
) {
  const sourceStats = await fs.lstat(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error("USER_TEST_AGENT_WORKSPACE_INVALID");
  }
  const manifest = await readOptionalRegularJson(path.join(source, "agent.json"));
  const promptFiles = allowedPromptFiles(config, manifest);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const fileName of new Set<string>([
    "agent.json",
    ...AGENT_PERSONA_FILES,
    ...promptFiles
  ])) {
    await copyOptionalRegularFile(source, destination, fileName);
  }
  await copySelectedPromptDirectory(
    path.join(source, "system-prompts"),
    path.join(destination, "system-prompts"),
    promptFiles
  );
}

async function copySelectedPromptDirectory(
  source: string,
  destination: string,
  promptFiles: ReadonlySet<string>
) {
  const stats = await lstatIfPresent(source);
  if (!stats) return;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const fileName of promptFiles) {
    await copyOptionalRegularFile(source, destination, fileName);
  }
}

async function copyOptionalRegularFile(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string
) {
  const source = path.resolve(sourceRoot, relativePath);
  const destination = path.resolve(destinationRoot, relativePath);
  assertInside(source, sourceRoot, "USER_TEST_AGENT_WORKSPACE_PATH_INVALID");
  assertInside(destination, destinationRoot, "USER_TEST_AGENT_WORKSPACE_PATH_INVALID");
  const stats = await lstatIfPresent(source);
  if (!stats) return;
  if (stats.isSymbolicLink()) throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
  if (!stats.isFile()) throw new Error("USER_TEST_AGENT_WORKSPACE_SPECIAL_FILE");
  await assertRegularDirectoryChain(sourceRoot, path.dirname(relativePath));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o600);
}

async function assertRegularDirectoryChain(root: string, relativeDirectory: string) {
  if (!relativeDirectory || relativeDirectory === ".") return;
  let current = root;
  for (const segment of relativeDirectory.split(/[\\/]/u).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
    }
  }
}

async function isolateAgentWorkspace(input: {
  workspace: string;
  configPath: string;
  agentId: string;
}) {
  const agentRoot = path.join(input.workspace, "business/agents", input.agentId);
  const rootStats = await fs.lstat(agentRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("USER_TEST_AGENT_WORKSPACE_INVALID");
  }
  await fs.chmod(agentRoot, 0o700);
  const config = JSON.parse(await fs.readFile(input.configPath, "utf8")) as Record<string, unknown>;
  const manifestPath = path.join(agentRoot, "agent.json");
  const manifest = await readOptionalJson(manifestPath);
  const promptFiles = allowedPromptFiles(config, manifest);
  const allowedRootFiles = new Set<string>([
    "agent.json",
    ...AGENT_PERSONA_FILES,
    ...promptFiles
  ]);
  for (const entry of await fs.readdir(agentRoot, { withFileTypes: true })) {
    const entryPath = path.join(agentRoot, entry.name);
    if (entry.name === "system-prompts") {
      await sanitizePromptDirectory(entryPath, promptFiles);
      continue;
    }
    if (allowedRootFiles.has(entry.name)) {
      if (entry.isSymbolicLink()) throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
      if (!entry.isFile()) throw new Error("USER_TEST_AGENT_WORKSPACE_SPECIAL_FILE");
      continue;
    }
    await fs.rm(entryPath, { recursive: true, force: true });
  }
}

function allowedPromptFiles(
  config: Record<string, unknown>,
  manifest: Record<string, unknown> | undefined
) {
  const files = new Set<string>(STANDARD_AGENT_PROMPT_FILES);
  const sharedBot = record(config.bot);
  const agentBot = record(manifest?.bot);
  for (const bot of [sharedBot, agentBot]) {
    const memory = record(bot.memory);
    const orchestrator = record(bot.orchestrator);
    for (const value of [
      memory.workMemoryCompressInPrompt,
      memory.workMemoryCompressOutPrompt,
      memory.userProfilePrompt,
      orchestrator.promptFile
    ]) {
      const fileName = safePromptFileName(value);
      if (fileName) files.add(fileName);
    }
  }
  return files;
}

function safePromptFileName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/\\/gu, "/");
  if (
    path.posix.isAbsolute(normalized)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.endsWith("/..")
  ) {
    return undefined;
  }
  return path.normalize(normalized);
}

async function sanitizePromptDirectory(
  directory: string,
  allowedFiles: ReadonlySet<string>
) {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
  }
  await sanitizePromptDirectoryEntries(directory, directory, allowedFiles);
}

async function sanitizePromptDirectoryEntries(
  root: string,
  directory: string,
  allowedFiles: ReadonlySet<string>
): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(root, entryPath);
    const allowed = allowedFiles.has(relative);
    if (entry.isSymbolicLink()) {
      if (allowed) throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
      await fs.rm(entryPath, { force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await sanitizePromptDirectoryEntries(root, entryPath, allowedFiles);
      if ((await fs.readdir(entryPath)).length === 0) await fs.rmdir(entryPath);
      continue;
    }
    if (allowed) {
      if (!entry.isFile()) throw new Error("USER_TEST_AGENT_WORKSPACE_SPECIAL_FILE");
      continue;
    }
    await fs.rm(entryPath, { force: true });
  }
}

async function readOptionalJson(filePath: string) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalRegularJson(filePath: string) {
  const stats = await lstatIfPresent(filePath);
  if (!stats) return undefined;
  if (stats.isSymbolicLink()) throw new Error("USER_TEST_AGENT_WORKSPACE_SYMLINK");
  if (!stats.isFile()) throw new Error("USER_TEST_AGENT_WORKSPACE_SPECIAL_FILE");
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function lstatIfPresent(candidate: string) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function resolveWorkspaceReference(workspace: string, configured: string) {
  if (path.isAbsolute(configured)) return path.normalize(configured);
  const normalized = configured.replace(/\\/gu, "/");
  if (normalized.startsWith("workspace/")) {
    return path.join(workspace, normalized.slice("workspace/".length));
  }
  return path.resolve(workspace, normalized);
}

async function assertRegularDirectoryTree(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("USER_TEST_PROMPT_WORKSPACE_SYMLINK");
    if (entry.isDirectory()) {
      await assertRegularDirectoryTree(entryPath);
      continue;
    }
    if (!entry.isFile()) throw new Error("USER_TEST_PROMPT_WORKSPACE_SPECIAL_FILE");
  }
}

function assertInside(candidate: string, root: string, code: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(code);
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
