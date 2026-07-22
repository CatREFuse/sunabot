import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../src/types.js";
import {
  resolvePromptWorkspace,
  resolveSafePromptFilePath,
  type PromptWorkspaceScope
} from "./promptWorkspace.js";

export interface PromptMigrationDefinition {
  id: string;
  scope: PromptWorkspaceScope;
  files: readonly string[];
  dependencies?: readonly string[];
  backupPolicy: "once" | "none";
  run(): Promise<unknown>;
  verify(): Promise<void>;
}

interface PromptMigrationJournalEntry {
  id: string;
  status: "started" | "completed";
  startedAt: string;
  completedAt?: string;
  inputDigest: string;
  outputDigest?: string;
}

interface PromptMigrationJournal {
  schemaVersion: 1;
  entries: Record<string, PromptMigrationJournalEntry>;
}

export interface PromptMigrationReportEntry {
  id: string;
  scope: PromptWorkspaceScope;
  status: "completed" | "pending";
  changed: boolean;
  inputDigest?: string;
  outputDigest?: string;
}

const JOURNAL_FILE = ".sunabot-prompt-migrations.json";
const BACKUP_DIRECTORY = ".prompt-migration-backups";
const workspaceLocks = new Map<string, Promise<void>>();

export async function runPromptMigrationRegistry(
  config: AppConfig,
  definitions: readonly PromptMigrationDefinition[],
  options: { dryRun?: boolean } = {}
) {
  const sorted = orderPromptMigrations(definitions);
  const report: PromptMigrationReportEntry[] = [];
  for (const scope of ["system", "persona"] as const) {
    const scoped = sorted.filter((definition) => definition.scope === scope);
    if (!scoped.length) continue;
    const workspace = resolvePromptWorkspace(config, scope);
    await withWorkspaceLock(workspace, async () => {
      const journalPath = await resolveSafePromptFilePath(config, scope, JOURNAL_FILE);
      const journal = await readJournal(journalPath);
      for (const definition of scoped) {
        const completed = journal.entries[definition.id]?.status === "completed";
        if (options.dryRun || completed) {
          report.push({
            id: definition.id,
            scope,
            status: completed ? "completed" : "pending",
            changed: false,
            ...(journal.entries[definition.id]?.inputDigest
              ? { inputDigest: journal.entries[definition.id]!.inputDigest }
              : {}),
            ...(journal.entries[definition.id]?.outputDigest
              ? { outputDigest: journal.entries[definition.id]!.outputDigest }
              : {})
          });
          continue;
        }

        const inputDigest = await digestPromptFiles(config, definition);
        const startedAt = new Date().toISOString();
        journal.entries[definition.id] = {
          id: definition.id,
          status: "started",
          startedAt,
          inputDigest
        };
        await writeJournal(journalPath, journal);
        if (definition.backupPolicy === "once") {
          await backupPromptFiles(config, definition, inputDigest);
        }
        await definition.run();
        await definition.verify();
        const outputDigest = await digestPromptFiles(config, definition);
        journal.entries[definition.id] = {
          id: definition.id,
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          inputDigest,
          outputDigest
        };
        await writeJournal(journalPath, journal);
        report.push({
          id: definition.id,
          scope,
          status: "completed",
          changed: inputDigest !== outputDigest,
          inputDigest,
          outputDigest
        });
      }
    });
  }
  return report;
}

export function orderPromptMigrations(definitions: readonly PromptMigrationDefinition[]) {
  const byId = new Map<string, PromptMigrationDefinition>();
  for (const definition of definitions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(definition.id)) {
      throw new Error(`Invalid prompt migration id: ${definition.id}`);
    }
    if (byId.has(definition.id)) throw new Error(`Duplicate prompt migration id: ${definition.id}`);
    byId.set(definition.id, definition);
  }

  const ordered: PromptMigrationDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Prompt migration dependency cycle: ${id}`);
    const definition = byId.get(id);
    if (!definition) throw new Error(`Missing prompt migration dependency: ${id}`);
    visiting.add(id);
    for (const dependency of definition.dependencies ?? []) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`Missing prompt migration dependency: ${dependency}`);
      if (target.scope !== definition.scope) {
        throw new Error(`Prompt migration dependencies cannot cross workspaces: ${definition.id}`);
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(definition);
  };
  for (const definition of definitions) visit(definition.id);
  return ordered;
}

async function readJournal(filePath: string): Promise<PromptMigrationJournal> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: {} };
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<PromptMigrationJournal>;
  if (parsed.schemaVersion !== 1 || !isRecord(parsed.entries)) {
    throw new Error("Prompt migration journal is invalid.");
  }
  for (const [id, entry] of Object.entries(parsed.entries)) {
    if (!isJournalEntry(entry) || entry.id !== id) throw new Error("Prompt migration journal is invalid.");
  }
  return parsed as PromptMigrationJournal;
}

async function writeJournal(filePath: string, journal: PromptMigrationJournal) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function backupPromptFiles(
  config: AppConfig,
  definition: PromptMigrationDefinition,
  inputDigest: string
) {
  for (const [index, fileName] of definition.files.entries()) {
    const content = await readPromptFileExact(config, definition.scope, fileName);
    if (!content) continue;
    const extension = path.extname(fileName) || ".txt";
    const backupName = `${String(index).padStart(2, "0")}-${createHash("sha256").update(fileName).digest("hex").slice(0, 16)}-${inputDigest.slice(0, 16)}${extension}`;
    const backupPath = await resolveSafePromptFilePath(
      config,
      definition.scope,
      path.join(BACKUP_DIRECTORY, definition.id.replace(/[^A-Za-z0-9._-]/g, "_"), backupName)
    );
    try {
      await fs.writeFile(backupPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(backupPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
        .catch((retryError) => {
          if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
        });
    }
  }
}

async function digestPromptFiles(config: AppConfig, definition: PromptMigrationDefinition) {
  const digest = createHash("sha256");
  for (const fileName of definition.files) {
    digest.update(fileName);
    digest.update("\0");
    digest.update(await readPromptFileExact(config, definition.scope, fileName));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function withWorkspaceLock<T>(workspace: string, task: () => Promise<T>) {
  const previous = workspaceLocks.get(workspace) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  workspaceLocks.set(workspace, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (workspaceLocks.get(workspace) === queued) workspaceLocks.delete(workspace);
  }
}

async function readPromptFileExact(config: AppConfig, scope: PromptWorkspaceScope, fileName: string) {
  const filePath = await resolveSafePromptFilePath(config, scope, fileName);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function isJournalEntry(value: unknown): value is PromptMigrationJournalEntry {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.status === "started" || value.status === "completed")
    && typeof value.startedAt === "string"
    && typeof value.inputDigest === "string"
    && (value.completedAt === undefined || typeof value.completedAt === "string")
    && (value.outputDigest === undefined || typeof value.outputDigest === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
