import fs from "node:fs/promises";
import path from "node:path";
import { prepareProviderSmokeWorkspace } from "../quality/prepare-runtime-smoke.mjs";

const MARKER_FILE = ".sunabot-user-test-workspace.json";

export async function prepareUserTestWorkspace(input: {
  source: string;
  destination: string;
  confirmCredentialCopy: boolean;
}) {
  const prepared = await prepareProviderSmokeWorkspace({
    source: input.source,
    destination: input.destination,
    confirmCredentialCopy: input.confirmCredentialCopy
  });
  await preparePromptWorkspace(prepared.source, prepared.destination, prepared.configPath);
  const isolatedAgentRoot = path.join(prepared.destination, "business/agents/plana");
  await fs.chmod(path.join(prepared.destination, "business/agents"), 0o700);
  await Promise.all([
    "WORKING_MEMORY.md",
    "WORKING_MEMORY.jsonl",
    "LONG_TERM_MEMORY.jsonl",
    "USER_PROFILE.jsonl"
  ].map((fileName) => fs.rm(
    path.join(isolatedAgentRoot, fileName),
    { force: true }
  )));
  await fs.rm(path.join(isolatedAgentRoot, "data"), { recursive: true, force: true });
  const marker = {
    schemaVersion: 1,
    purpose: "sunabot-user-test-harness",
    createdAt: new Date().toISOString(),
    sourceDigest: path.basename(path.resolve(input.source))
  };
  await fs.writeFile(
    path.join(prepared.destination, MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" }
  );
  return prepared;
}

export async function assertUserTestWorkspace(workspace: string) {
  if (!path.isAbsolute(workspace)) throw new Error("USER_TEST_WORKSPACE_NOT_ABSOLUTE");
  const markerPath = path.join(path.resolve(workspace), MARKER_FILE);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
  if (marker.schemaVersion !== 1 || marker.purpose !== "sunabot-user-test-harness") {
    throw new Error("USER_TEST_WORKSPACE_MARKER_INVALID");
  }
  return path.resolve(workspace);
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
    await fs.cp(realSource, destinationPromptWorkspace, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
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
