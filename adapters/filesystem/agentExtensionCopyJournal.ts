import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAgentId,
  assertExtensionId,
  compareBinaryText,
  parseAgentMcpServerIndex,
  parseAgentSkillIndex,
  type AgentExtensionCopyConflictStrategy,
  type AgentMcpServerIndex,
  type AgentSkillIndex
} from "../../packages/contracts/extensions/agentExtensions.js";
import {
  atomicJson,
  atomicPrivateData,
  readPrivateData,
  removePrivateDataFile,
  storeError,
  terminalizePrivateDataFile
} from "./agentExtensionSecureFs.js";
import { AgentExtensionPathGuard } from "./agentExtensionPaths.js";
import { extensionRevision } from "./agentSkillPersistence.js";

const MAX_COPY_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_COPY_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_COPY_ARCHIVE_FILES = 4;
const MAX_COPY_TERMINAL_FILES = 16;
const MAX_COPY_TERMINAL_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CopyArchiveReference {
  name: string;
  bytes: number;
  sha256: string;
}

export interface AgentExtensionCopyJournal {
  schemaVersion: 1;
  state: "prepared" | "committed" | "rolled_back";
  id: string;
  createdAt: string;
  sourceAgentId: string;
  targetAgentId: string;
  previewRevision: string;
  sourceSkillRevision: string;
  targetSkillRevision: string;
  sourceMcpRevision: string;
  targetMcpRevision: string;
  conflictStrategy: AgentExtensionCopyConflictStrategy;
  targetSkillId: string;
  skillWillChange: boolean;
  expectedSkillDigestSha256: string;
  sourceSkillId: string;
  beforeSkillIndex: AgentSkillIndex;
  afterSkillIndex: AgentSkillIndex | null;
  beforeMcpIndex: AgentMcpServerIndex;
  afterMcpIndex: AgentMcpServerIndex;
  changedMcpServerIds: string[];
  sourceArchive: CopyArchiveReference;
  previousArchive: CopyArchiveReference | null;
}

export interface AgentExtensionCopyJournalHandle {
  id: string;
  targetAgentId: string;
}

export class AgentExtensionCopyJournalStore {
  constructor(
    private readonly pathGuard: AgentExtensionPathGuard,
    private readonly fault?: (step: string) => void | Promise<void>
  ) {}

  async begin(input: {
    sourceAgentId: string;
    targetAgentId: string;
    previewRevision: string;
    sourceSkillRevision: string;
    targetSkillRevision: string;
    sourceMcpRevision: string;
    targetMcpRevision: string;
    conflictStrategy: AgentExtensionCopyConflictStrategy;
    targetSkillId: string;
    sourceSkillId: string;
    skillWillChange: boolean;
    expectedSkillDigestSha256: string;
    beforeSkillIndex: AgentSkillIndex;
    beforeMcpIndex: AgentMcpServerIndex;
    afterMcpIndex: AgentMcpServerIndex;
    changedMcpServerIds: string[];
    sourceArchive: Buffer;
    previousArchive?: Buffer;
  }): Promise<AgentExtensionCopyJournalHandle> {
    const id = randomUUID();
    const paths = await this.pathGuard.paths(input.targetAgentId);
    await this.pathGuard.guard(paths, "prepare-extension-copy-journal");
    const sourceArchive = archiveReference(id, "source", input.sourceArchive);
    const previousArchive = input.previousArchive
      ? archiveReference(id, "previous", input.previousArchive)
      : null;
    await atomicPrivateData(path.join(paths.skills, sourceArchive.name), input.sourceArchive);
    await this.fault?.("after-copy-source-archive");
    if (previousArchive && input.previousArchive) {
      await atomicPrivateData(path.join(paths.skills, previousArchive.name), input.previousArchive);
      await this.fault?.("after-copy-previous-archive");
    }
    const journal: AgentExtensionCopyJournal = {
      schemaVersion: 1,
      state: "prepared",
      id,
      createdAt: new Date().toISOString(),
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
      previewRevision: input.previewRevision,
      sourceSkillRevision: input.sourceSkillRevision,
      targetSkillRevision: input.targetSkillRevision,
      sourceMcpRevision: input.sourceMcpRevision,
      targetMcpRevision: input.targetMcpRevision,
      conflictStrategy: input.conflictStrategy,
      targetSkillId: input.targetSkillId,
      skillWillChange: input.skillWillChange,
      expectedSkillDigestSha256: input.expectedSkillDigestSha256,
      sourceSkillId: input.sourceSkillId,
      beforeSkillIndex: structuredClone(input.beforeSkillIndex),
      afterSkillIndex: null,
      beforeMcpIndex: structuredClone(input.beforeMcpIndex),
      afterMcpIndex: structuredClone(input.afterMcpIndex),
      changedMcpServerIds: [...input.changedMcpServerIds].sort(),
      sourceArchive,
      previousArchive
    };
    await atomicJson(activeJournalPath(paths.skills, id), journal);
    return { id, targetAgentId: input.targetAgentId };
  }

  async recordSkillIndex(handle: AgentExtensionCopyJournalHandle, index: AgentSkillIndex) {
    const { journal, path: journalPath } = await this.readActive(handle);
    if (journal.state !== "prepared" || journal.afterSkillIndex) recoveryRequired();
    await atomicJson(journalPath, { ...journal, afterSkillIndex: structuredClone(index) });
  }

  async terminalize(
    handle: AgentExtensionCopyJournalHandle,
    state: "committed" | "rolled_back"
  ) {
    const { journal, path: journalPath, skills } = await this.readActive(handle);
    if (journal.state !== "prepared" && journal.state !== state) recoveryRequired();
    const terminal = journal.state === "prepared" ? { ...journal, state } : journal;
    if (journal.state === "prepared") await atomicJson(journalPath, terminal);
    await removeJournalArchives(skills, terminal);
    const activeStat = await fs.lstat(journalPath, { bigint: true });
    if (!activeStat.isFile() || activeStat.isSymbolicLink() || activeStat.nlink !== 1n ||
        activeStat.size < 1n || activeStat.size > BigInt(MAX_COPY_JOURNAL_BYTES)) recoveryRequired();
    await pruneTerminalJournals(skills, Number(activeStat.size), 1);
    await terminalizePrivateDataFile(journalPath, terminalJournalPath(skills, handle.id, state));
  }

  async active(agentId: string) {
    const paths = await this.pathGuard.paths(agentId);
    await this.pathGuard.guard(paths, "scan-extension-copy-journals");
    const entries = await fs.readdir(paths.skills);
    const names = entries
      .filter((name) => /^\.copy-transaction-[0-9a-f-]+\.json$/iu.test(name))
      .sort();
    const journals = [];
    const referencedArchives = new Set<string>();
    for (const name of names) {
      const journalPath = path.join(paths.skills, name);
      const journal = parseJournalSafely(await readJsonBounded(journalPath));
      if (journal.targetAgentId !== agentId || name !== path.basename(activeJournalPath(paths.skills, journal.id))) {
        recoveryRequired();
      }
      referencedArchives.add(journal.sourceArchive.name);
      if (journal.previousArchive) referencedArchives.add(journal.previousArchive.name);
      journals.push({ journal, path: journalPath, skills: paths.skills });
    }
    const archives = entries.filter((name) => /^\.copy-(?:source|previous)-archive-[0-9a-f-]+\.zip$/iu.test(name));
    if (archives.length > MAX_COPY_ARCHIVE_FILES) recoveryRequired();
    for (const name of archives) {
      if (!referencedArchives.has(name)) await removePrivateDataFile(path.join(paths.skills, name));
    }
    await pruneTerminalJournals(paths.skills, 0, 0);
    await this.pathGuard.refresh(paths, { allowChanged: [paths.skills] });
    await this.pathGuard.guard(paths, "scan-extension-copy-journals-complete");
    return journals;
  }

  async get(handle: AgentExtensionCopyJournalHandle) {
    return this.readActive(handle);
  }

  async readArchive(skills: string, reference: CopyArchiveReference) {
    const filePath = path.join(skills, reference.name);
    const content = await readPrivateData(filePath, MAX_COPY_ARCHIVE_BYTES);
    if (content.length !== reference.bytes || digest(content) !== reference.sha256) {
      content.fill(0);
      recoveryRequired();
    }
    return content;
  }

  private async readActive(handle: AgentExtensionCopyJournalHandle) {
    const paths = await this.pathGuard.paths(handle.targetAgentId);
    const journalPath = activeJournalPath(paths.skills, handle.id);
    const journal = parseJournalSafely(await readJsonBounded(journalPath));
    if (journal.id !== handle.id || journal.targetAgentId !== handle.targetAgentId) recoveryRequired();
    return { journal, path: journalPath, skills: paths.skills };
  }
}

async function removeJournalArchives(skills: string, journal: AgentExtensionCopyJournal) {
  await removePrivateDataFile(path.join(skills, journal.sourceArchive.name));
  if (journal.previousArchive) {
    await removePrivateDataFile(path.join(skills, journal.previousArchive.name));
  }
}

async function pruneTerminalJournals(skills: string, additionalBytes: number, additionalFiles: number) {
  const names = (await fs.readdir(skills)).filter((name) =>
    /^\.copy-(?:committed|rolled_back)-transaction-[0-9a-f-]+\.json$/iu.test(name));
  const terminals: Array<{ name: string; bytes: number; createdAt: string; id: string }> = [];
  for (const name of names) {
    const match = /^\.copy-(committed|rolled_back)-transaction-([0-9a-f-]+)\.json$/iu.exec(name);
    if (!match) recoveryRequired();
    const filePath = path.join(skills, name);
    const journal = parseJournalSafely(await readJsonBounded(filePath));
    const expectedState = match[1] === "committed" ? "committed" : "rolled_back";
    if (journal.state !== expectedState || journal.id.toLowerCase() !== match[2]!.toLowerCase()) recoveryRequired();
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n ||
        stat.size > BigInt(MAX_COPY_JOURNAL_BYTES)) recoveryRequired();
    terminals.push({ name, bytes: Number(stat.size), createdAt: journal.createdAt, id: journal.id });
  }
  terminals.sort((left, right) => left.createdAt < right.createdAt ? -1 :
    left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  let bytes = terminals.reduce((total, terminal) => total + terminal.bytes, additionalBytes);
  let files = terminals.length + additionalFiles;
  while (files > MAX_COPY_TERMINAL_FILES || bytes > MAX_COPY_TERMINAL_BYTES) {
    const oldest = terminals.shift();
    if (!oldest) recoveryRequired();
    await removePrivateDataFile(path.join(skills, oldest.name));
    bytes -= oldest.bytes;
    files -= 1;
  }
}

function archiveReference(id: string, kind: "source" | "previous", content: Buffer): CopyArchiveReference {
  if (content.length < 1 || content.length > MAX_COPY_ARCHIVE_BYTES) {
    throw storeError(409, "AGENT_EXTENSION_COPY_ARCHIVE_INVALID", "复制事务归档无效。");
  }
  return {
    name: `.copy-${kind}-archive-${id}.zip`,
    bytes: content.length,
    sha256: digest(content)
  };
}

function activeJournalPath(skills: string, id: string) {
  if (!TRANSACTION_ID.test(id)) recoveryRequired();
  return path.join(skills, `.copy-transaction-${id}.json`);
}

function terminalJournalPath(skills: string, id: string, state: "committed" | "rolled_back") {
  return path.join(skills, `.copy-${state}-transaction-${id}.json`);
}

async function readJsonBounded(filePath: string) {
  const content = await readPrivateData(filePath, MAX_COPY_JOURNAL_BYTES);
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    recoveryRequired();
  } finally {
    content.fill(0);
  }
}

function parseJournal(value: unknown): AgentExtensionCopyJournal {
  const keys = [
    "schemaVersion", "state", "id", "createdAt", "sourceAgentId", "targetAgentId", "previewRevision",
    "sourceSkillRevision", "targetSkillRevision", "sourceMcpRevision", "targetMcpRevision",
    "conflictStrategy", "targetSkillId", "skillWillChange", "expectedSkillDigestSha256",
    "sourceSkillId", "beforeSkillIndex", "afterSkillIndex", "beforeMcpIndex", "afterMcpIndex",
    "changedMcpServerIds", "sourceArchive", "previousArchive"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) recoveryRequired();
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 ||
      (raw.state !== "prepared" && raw.state !== "committed" && raw.state !== "rolled_back") ||
      typeof raw.id !== "string" || !TRANSACTION_ID.test(raw.id) ||
      typeof raw.createdAt !== "string" || !validTimestamp(raw.createdAt) ||
      typeof raw.skillWillChange !== "boolean" ||
      (raw.conflictStrategy !== "skip" && raw.conflictStrategy !== "replace" && raw.conflictStrategy !== "rename")) {
    recoveryRequired();
  }
  for (const field of [
    "previewRevision", "sourceSkillRevision", "targetSkillRevision", "sourceMcpRevision",
    "targetMcpRevision", "expectedSkillDigestSha256"
  ]) {
    if (typeof raw[field] !== "string" || !DIGEST.test(raw[field] as string)) recoveryRequired();
  }
  const sourceAgentId = assertAgentId(raw.sourceAgentId);
  const targetAgentId = assertAgentId(raw.targetAgentId);
  const targetSkillId = assertExtensionId(raw.targetSkillId, "targetSkillId");
  const sourceSkillId = assertExtensionId(raw.sourceSkillId, "sourceSkillId");
  const beforeSkillIndex = validSkillIndex(raw.beforeSkillIndex);
  const afterSkillIndex = raw.afterSkillIndex === null ? null : validSkillIndex(raw.afterSkillIndex);
  const beforeMcpIndex = validMcpIndex(raw.beforeMcpIndex);
  const afterMcpIndex = validMcpIndex(raw.afterMcpIndex);
  if (!Array.isArray(raw.changedMcpServerIds) || raw.changedMcpServerIds.length > 128) recoveryRequired();
  const changedMcpServerIds = raw.changedMcpServerIds.map((id) => assertExtensionId(id, "changedMcpServerIds"));
  if (new Set(changedMcpServerIds).size !== changedMcpServerIds.length ||
      JSON.stringify(changedMcpServerIds) !== JSON.stringify([...changedMcpServerIds].sort())) recoveryRequired();
  return {
    schemaVersion: 1,
    state: raw.state,
    id: raw.id,
    createdAt: raw.createdAt as string,
    sourceAgentId,
    targetAgentId,
    previewRevision: raw.previewRevision as string,
    sourceSkillRevision: raw.sourceSkillRevision as string,
    targetSkillRevision: raw.targetSkillRevision as string,
    sourceMcpRevision: raw.sourceMcpRevision as string,
    targetMcpRevision: raw.targetMcpRevision as string,
    conflictStrategy: raw.conflictStrategy,
    targetSkillId,
    skillWillChange: raw.skillWillChange,
    expectedSkillDigestSha256: raw.expectedSkillDigestSha256 as string,
    sourceSkillId,
    beforeSkillIndex,
    afterSkillIndex,
    beforeMcpIndex,
    afterMcpIndex,
    changedMcpServerIds,
    sourceArchive: parseArchiveReference(raw.sourceArchive, raw.id, "source"),
    previousArchive: raw.previousArchive === null
      ? null
      : parseArchiveReference(raw.previousArchive, raw.id, "previous")
  };
}

function parseJournalSafely(value: unknown) {
  try {
    return parseJournal(value);
  } catch {
    recoveryRequired();
  }
}

function validSkillIndex(value: unknown) {
  const index = parseAgentSkillIndex(value);
  const ordered = [...index.skills].sort((left, right) => compareBinaryText(left.id, right.id));
  if (index.revision !== extensionRevision(ordered) || JSON.stringify(index.skills) !== JSON.stringify(ordered)) {
    recoveryRequired();
  }
  return index;
}

function validMcpIndex(value: unknown) {
  const index = parseAgentMcpServerIndex(value);
  const ordered = [...index.servers].sort((left, right) => compareBinaryText(left.id, right.id));
  if (index.revision !== extensionRevision(ordered) || JSON.stringify(index.servers) !== JSON.stringify(ordered)) {
    recoveryRequired();
  }
  return index;
}

function parseArchiveReference(value: unknown, id: string, kind: "source" | "previous") {
  if (!value || typeof value !== "object" || Array.isArray(value)) recoveryRequired();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3 || typeof raw.name !== "string" ||
      raw.name !== `.copy-${kind}-archive-${id}.zip` || !Number.isSafeInteger(raw.bytes) ||
      (raw.bytes as number) < 1 || (raw.bytes as number) > MAX_COPY_ARCHIVE_BYTES ||
      typeof raw.sha256 !== "string" || !DIGEST.test(raw.sha256)) recoveryRequired();
  return { name: raw.name, bytes: raw.bytes as number, sha256: raw.sha256 };
}

function digest(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function validTimestamp(value: string) {
  if (value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function recoveryRequired(): never {
  throw storeError(409, "AGENT_EXTENSION_COPY_RECOVERY_REQUIRED", "复制事务需要人工恢复。");
}
