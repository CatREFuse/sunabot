#!/usr/bin/env node

// Read-only structural audit. Never emit manifest Bot settings, credentials, or raw QQ IDs.
import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_FILES = [
  "agent.json",
  "AGENTS.md",
  "SOUL.md",
  "PREFERENCE.md",
  "DIALOGUE_STYLE_EXAMPLES.md",
  "USER.md",
  "RELATION.md",
  "AIR.md",
  "DIRECTOR_SEED.md",
  "WORKING_MEMORY.md",
  "selfie_prompt_rewrite.json",
  "workbench/index.md",
  "workbench/selfie/references.jsonl",
  "workbench/emoji/emojis.jsonl",
  "workbench/skills/index.json",
  "workbench/knowledge/index.json",
  "extensions/mcp/servers.json"
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    "Usage: audit-bot.mjs --workspace <workspace> --agent <agent-id> [--json]\n"
  );
  process.exit(0);
}

if (!args.workspace || !args.agent) fail("Both --workspace and --agent are required.");
if (!/^[a-z][a-z0-9-]{1,31}$/.test(args.agent)) fail("Invalid Agent ID.");

const workspace = path.resolve(args.workspace);
const agentDirectory = path.join(workspace, "business", "agents", args.agent);
await assertDirectDirectory(agentDirectory, "Agent workspace");

const manifest = await readJson(path.join(agentDirectory, "agent.json"), "agent.json");
const missingFiles = [];
for (const relativePath of REQUIRED_FILES) {
  if (!(await directFile(path.join(agentDirectory, relativePath)))) missingFiles.push(relativePath);
}

const skills = await readOptionalIndex(
  path.join(agentDirectory, "workbench", "skills", "index.json"),
  "skills"
);
const knowledge = await readOptionalIndex(
  path.join(agentDirectory, "workbench", "knowledge", "index.json"),
  "knowledge"
);
const mcp = await readOptionalIndex(
  path.join(agentDirectory, "extensions", "mcp", "servers.json"),
  "servers"
);
const selfieReferences = await countNonBlankLines(
  path.join(agentDirectory, "workbench", "selfie", "references.jsonl")
);
const emojiEntries = await countNonBlankLines(
  path.join(agentDirectory, "workbench", "emoji", "emojis.jsonl")
);
const workingMemoryBytes = await fileSize(path.join(agentDirectory, "WORKING_MEMORY.md"));
const systemPromptFiles = await countDirectFiles(path.join(agentDirectory, "system-prompts"));
const avatarConfigured = typeof manifest.avatarPath === "string" && Boolean(manifest.avatarPath);
const avatarPath = safeRelativePath(manifest.avatarPath);
const avatarPresent = avatarPath
  ? await directFile(path.join(agentDirectory, ...avatarPath.split("/")))
  : false;
const voice = await inspectVoice(path.join(agentDirectory, "voice", "profile.json"));
const registry = inspectRegistry(
  path.join(workspace, "business", "data", "sunabot.sqlite"),
  args.agent
);
const applicationDatabase = inspectDatabase(
  path.join(agentDirectory, "data", "sunabot.sqlite")
);
const sessionDatabase = inspectDatabase(
  path.join(agentDirectory, "data", "session-queue.sqlite")
);

const warnings = [];
if (manifest.schemaVersion !== 1) warnings.push("agent.json schemaVersion is not 1");
if (manifest.id !== args.agent) warnings.push("agent.json id does not match the requested Agent");
if (typeof manifest.name !== "string" || !manifest.name.trim()) warnings.push("agent.json name is missing");
if (manifest.enabled !== true) warnings.push("Agent is not enabled");
if (avatarConfigured && !avatarPath) warnings.push("Configured avatar path is unsafe");
if (avatarPath && !avatarPresent) warnings.push("Configured avatar is missing or unsafe");
if (!registry.present) warnings.push("Shared Agent registry row is missing");
if (registry.present && registry.enabled !== true) warnings.push("Shared Agent registry row is disabled");
if (registry.present && registry.workspaceMatches !== true) warnings.push("Shared Agent registry workspace does not match");
if (missingFiles.length) warnings.push("Required initial files are missing");
if (skills.value?.schemaVersion !== 1) warnings.push("Skill index schemaVersion is not 1");
if (knowledge.value?.schemaVersion !== 1) warnings.push("Knowledge index schemaVersion is not 1");
if (mcp.value?.schemaVersion !== 1) warnings.push("MCP index schemaVersion is not 1");
if (!applicationDatabase.present || applicationDatabase.tableCount === 0) {
  warnings.push("Agent application database is not initialized");
}
if (!sessionDatabase.present || sessionDatabase.tableCount === 0) {
  warnings.push("Agent session database is not initialized");
}
if (!skills.items.some((item) => item?.id === "workbench-config")) {
  warnings.push("Bundled workbench-config Skill is missing");
} else if (!skills.items.some((item) => item?.id === "workbench-config" && item?.enabled === true)) {
  warnings.push("Bundled workbench-config Skill is disabled");
}
if (manifest.prompts?.overrideSystem === true && systemPromptFiles === 0) {
  warnings.push("System prompt override is enabled but no override files were found");
}

const report = {
  schemaVersion: 1,
  agent: {
    id: args.agent,
    name: typeof manifest.name === "string" ? manifest.name : "",
    enabled: manifest.enabled === true,
    avatarConfigured,
    avatarPresent,
    systemPromptSource: manifest.prompts?.overrideSystem === true ? "agent" : "shared",
    inactiveAgentSystemPromptFiles:
      manifest.prompts?.overrideSystem === true ? 0 : systemPromptFiles
  },
  initialization: {
    requiredFiles: REQUIRED_FILES.length,
    missingFiles,
    registry,
    applicationDatabase,
    sessionDatabase,
    bundledWorkbenchSkillPresent:
      skills.items.some((item) => item?.id === "workbench-config"),
    bundledWorkbenchSkillEnabled:
      skills.items.some((item) => item?.id === "workbench-config" && item?.enabled === true)
  },
  accumulatedState: {
    workingMemoryBytes,
    selfieReferenceEntries: selfieReferences,
    emojiEntries,
    skillEntries: skills.items.length,
    knowledgeDocuments:
      Number.isSafeInteger(knowledge.value?.fileCount) ? knowledge.value.fileCount : 0,
    mcpServers: mcp.items.length,
    voice
  },
  warnings,
  ok: warnings.length === 0
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 2;

function parseArgs(values) {
  const result = { workspace: "", agent: "", json: false, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--workspace") result.workspace = values[++index] ?? "";
    else if (value === "--agent") result.agent = values[++index] ?? "";
    else if (value === "--json") result.json = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else fail(`Unknown argument: ${value}`);
  }
  return result;
}

async function assertDirectDirectory(target, label) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${target}`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a direct directory: ${target}`);
}

async function directFile(target) {
  try {
    const stat = await fs.lstat(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(target, label) {
  if (!(await directFile(target))) fail(`${label} is missing or is not a direct file.`);
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

async function readOptionalIndex(target, arrayKey) {
  if (!(await directFile(target))) return { value: undefined, items: [] };
  const value = await readJson(target, path.basename(target));
  return {
    value,
    items: Array.isArray(value?.[arrayKey]) ? value[arrayKey] : []
  };
}

async function countNonBlankLines(target) {
  if (!(await directFile(target))) return 0;
  const content = await fs.readFile(target, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function fileSize(target) {
  if (!(await directFile(target))) return 0;
  return Number((await fs.stat(target)).size);
}

async function countDirectFiles(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)) {
    return "";
  }
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") ? value : "";
}

function inspectRegistry(databasePath, agentId) {
  if (!syncDirectFile(databasePath)) return { present: false, accountCount: 0, boundAccounts: 0 };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const agent = database.prepare(
      "SELECT id, name, enabled, workspace, avatar_path FROM agents WHERE id = ?"
    ).get(agentId);
    const accounts = database.prepare(
      "SELECT label, enabled, webui_port, qq_id IS NOT NULL AS bound FROM agent_accounts WHERE agent_id = ? ORDER BY created_at"
    ).all(agentId);
    return {
      present: Boolean(agent),
      enabled: agent?.enabled === 1,
      workspaceMatches:
        agent?.workspace === `workspace/business/agents/${agentId}`,
      accountCount: accounts.length,
      boundAccounts: accounts.filter((item) => item.bound === 1).length,
      accounts: accounts.map((item) => ({
        label: String(item.label ?? ""),
        enabled: item.enabled === 1,
        webuiPort: Number(item.webui_port),
        qqBound: item.bound === 1
      }))
    };
  } finally {
    database.close();
  }
}

function inspectDatabase(databasePath) {
  if (!syncDirectFile(databasePath)) return { present: false, tableCount: 0 };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).get();
    return {
      present: true,
      tableCount: Number(row?.count ?? 0)
    };
  } finally {
    database.close();
  }
}

function syncDirectFile(target) {
  try {
    const stat = lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectVoice(target) {
  if (!(await directFile(target))) {
    return { profilePresent: false, enabled: false, configuredLanguages: 0 };
  }
  const profile = await readJson(target, "voice/profile.json");
  const languages = profile?.languages && typeof profile.languages === "object"
    ? Object.values(profile.languages)
    : [];
  return {
    profilePresent: true,
    enabled: profile.enabled === true,
    defaultLanguage:
      typeof profile.defaultLanguage === "string" ? profile.defaultLanguage : "",
    configuredLanguages: languages.filter(Boolean).length
  };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
