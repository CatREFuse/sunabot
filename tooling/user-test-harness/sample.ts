import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationRecord } from "../../packages/contracts/messaging/messages.js";
import {
  parseWorkingMemoryMarkdown
} from "../../services/memory/workingMemoryDocument.js";
import type { DreamPersonaFixture } from "./contracts.js";
import { buildSanitizedBranchSample } from "./sanitizedSample.js";

export async function sampleBranchFixture(input: {
  sourceWorkspace: string;
  agentId: string;
  outputPath: string;
  conversationLimit?: number;
  memoryLimit?: number;
}) {
  const workspace = path.resolve(input.sourceWorkspace);
  const agentId = validAgentId(input.agentId);
  const outputPath = path.resolve(input.outputPath);
  if (!path.isAbsolute(input.sourceWorkspace) || !path.isAbsolute(input.outputPath)) {
    throw new Error("USER_TEST_SAMPLE_PATH_NOT_ABSOLUTE");
  }
  const agentRoot = agentId === "plana"
    ? path.join(workspace, "business/agents/plana")
    : path.join(workspace, "business/agents", agentId);
  const databasePath = agentId === "plana"
    ? path.join(workspace, "business/data/sunabot.sqlite")
    : path.join(agentRoot, "data/sunabot.sqlite");
  const workingMemoryPath = path.join(agentRoot, "WORKING_MEMORY.md");
  const [workingMemoryRealPath, databaseRealPath, workspaceRealPath] = await Promise.all([
    fs.realpath(workingMemoryPath),
    fs.realpath(databasePath),
    fs.realpath(workspace)
  ]);
  await assertSafeNewOutput(outputPath, workspaceRealPath);
  assertInside(
    workingMemoryRealPath,
    workspaceRealPath,
    "USER_TEST_SAMPLE_WORKING_MEMORY_OUTSIDE_WORKSPACE"
  );
  assertInside(databaseRealPath, workspaceRealPath, "USER_TEST_SAMPLE_DATABASE_OUTSIDE_WORKSPACE");
  const workingMemory = parseWorkingMemoryMarkdown(
    (await fs.readFile(workingMemoryRealPath, "utf8")).replace(/\r\n/gu, "\n").trimEnd()
  );
  const persona = await readPersonaFixture(agentRoot, workspaceRealPath);
  const database = new DatabaseSync(databaseRealPath, { readOnly: true });
  let conversations: unknown[] = [];
  let longTerm: unknown[] = [];
  let userProfiles: unknown[] = [];
  try {
    database.exec("PRAGMA query_only = ON");
    conversations = database.prepare(
      "SELECT data_json FROM conversations ORDER BY last_at DESC, id ASC LIMIT ?"
    ).all(boundedLimit(input.conversationLimit, 8, 1, 32))
      .map((row) => parseJson((row as Record<string, unknown>).data_json));
    const memoryLimit = boundedLimit(input.memoryLimit, 64, 1, 256);
    const memoryStatement = database.prepare(
      "SELECT data_json FROM memory_records WHERE source = ? ORDER BY position DESC, data_json ASC LIMIT ?"
    );
    longTerm = memoryStatement.all("long_term", memoryLimit)
      .map((row) => parseJson((row as Record<string, unknown>).data_json));
    userProfiles = memoryStatement.all("user_profile", memoryLimit)
      .map((row) => parseJson((row as Record<string, unknown>).data_json));
  } finally {
    database.close();
  }
  const sample = buildSanitizedBranchSample({
    workingMemory,
    conversations: conversations as ConversationRecord[],
    longTerm: longTerm as Record<string, unknown>[],
    userProfiles: userProfiles as Record<string, unknown>[],
    persona
  });
  await writeExclusiveRegularFile(outputPath, `${JSON.stringify(sample, null, 2)}\n`);
  return {
    outputPath,
    digest: crypto.createHash("sha256").update(JSON.stringify(sample)).digest("hex"),
    counts: {
      conversations: conversations.length,
      longTerm: longTerm.length,
      userProfiles: userProfiles.length
    }
  };
}

async function readPersonaFixture(
  agentRoot: string,
  workspaceRealPath: string
): Promise<DreamPersonaFixture> {
  const read = (fileName: string) => readOptionalRegularFileInside(
    path.join(agentRoot, fileName),
    workspaceRealPath
  );
  const [soul, preference, user, relation, air] = await Promise.all([
    read("SOUL.md"),
    read("PREFERENCE.md"),
    read("USER.md"),
    read("RELATION.md"),
    read("AIR.md")
  ]);
  return {
    name: "fixture-agent",
    soul,
    preference,
    user,
    relation,
    air
  };
}

async function readOptionalRegularFileInside(filePath: string, root: string) {
  try {
    const realPath = await fs.realpath(filePath);
    assertInside(realPath, root, "USER_TEST_SAMPLE_PERSONA_OUTSIDE_WORKSPACE");
    const stats = await fs.lstat(realPath);
    if (!stats.isFile()) throw new Error("USER_TEST_SAMPLE_PERSONA_NOT_REGULAR");
    return await fs.readFile(realPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function assertSafeNewOutput(outputPath: string, sourceWorkspace: string) {
  const parent = path.dirname(outputPath);
  const [parentRealPath, parentStats] = await Promise.all([
    fs.realpath(parent),
    fs.lstat(parent)
  ]);
  if (!parentStats.isDirectory()) throw new Error("USER_TEST_SAMPLE_OUTPUT_PARENT_INVALID");
  assertOutside(
    parentRealPath,
    sourceWorkspace,
    "USER_TEST_SAMPLE_OUTPUT_INSIDE_SOURCE"
  );
  const existing = await fs.lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new Error("USER_TEST_SAMPLE_OUTPUT_EXISTS");
}

async function writeExclusiveRegularFile(filePath: string, content: string) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertInside(candidate: string, root: string, code: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(code);
  }
}

function assertOutside(candidate: string, root: string, code: string) {
  const relative = path.relative(root, candidate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(code);
  }
}

function validAgentId(value: string) {
  const agentId = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)) throw new Error("USER_TEST_SAMPLE_AGENT_INVALID");
  return agentId;
}

function boundedLimit(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function parseJson(value: unknown) {
  return JSON.parse(String(value));
}
