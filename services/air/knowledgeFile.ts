import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../../packages/platform/projectPaths.js";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { AIR_KNOWLEDGE_FILE } from "./contracts.js";

export const AIR_KNOWLEDGE_MAX_BYTES = 64 * 1024;

export async function readAirKnowledge(config: AppConfig) {
  const filePath = await resolveAirKnowledgePath(config);
  const content = await readOptional(filePath);
  assertAirKnowledgeSize(content);
  return { filePath, content: content.trim(), revision: revision(content) };
}

async function resolveAirKnowledgePath(config: AppConfig) {
  const configured = resolveProjectPath(config.persona.agentWorkspace);
  if (!configured) throw new Error("Agent workspace is not configured.");
  const workspace = path.resolve(configured);
  const filePath = path.join(workspace, AIR_KNOWLEDGE_FILE);
  const paths = [workspace, filePath];
  for (const [index, candidate] of paths.entries()) {
    try {
      const stat = await fs.lstat(candidate);
      const leaf = index === paths.length - 1;
      if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
        throw airPathError();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return filePath;
}

function airPathError() {
  return Object.assign(new Error("AIR.md path contains an invalid or symbolic-link component."), {
    code: "AIR_PATH_INVALID"
  });
}

export async function replaceAirKnowledge(
  config: AppConfig,
  expectedRevision: string,
  content: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const normalized = normalizeAirKnowledge(content);
  const current = await readAirKnowledge(config);
  signal?.throwIfAborted();
  if (current.revision !== expectedRevision) return { status: "conflict" as const, current };
  if (current.content === normalized) return { status: "unchanged" as const, current };
  const previousRaw = await readOptional(current.filePath);
  signal?.throwIfAborted();
  if (revision(previousRaw) !== current.revision) {
    return { status: "conflict" as const, current: await readAirKnowledge(config) };
  }

  const temporary = `${current.filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(current.filePath), { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  await fs.writeFile(temporary, `${normalized}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let renamed = false;
  try {
    signal?.throwIfAborted();
    const latest = await readAirKnowledge(config);
    signal?.throwIfAborted();
    if (latest.revision !== expectedRevision) {
      await fs.rm(temporary, { force: true });
      return { status: "conflict" as const, current: latest };
    }
    await fs.rename(temporary, current.filePath);
    renamed = true;
    signal?.throwIfAborted();
    const updated = await readAirKnowledge(config);
    signal?.throwIfAborted();
    return { status: "updated" as const, current: updated };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (renamed && signal?.aborted) {
      await restoreCancelledAirWrite(current.filePath, revision(`${normalized}\n`), previousRaw);
    }
    throw error;
  }
}

export function normalizeAirKnowledge(value: string) {
  const content = value.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (!content) throw new Error("Read-air output is empty.");
  const headings = content.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^#{1,2}\s/u.test(line));
  const expectedHeadings = ["# 场域知识", "## 使用边界", "## 场域约定"];
  if (headings[0] !== expectedHeadings[0]) {
    throw new Error("Read-air output must start with '# 场域知识'.");
  }
  for (const heading of expectedHeadings.slice(1)) {
    if (!headings.includes(heading)) throw new Error(`Read-air output is missing '${heading.slice(3)}'.`);
  }
  if (
    headings.length !== expectedHeadings.length
    || headings.some((heading, index) => heading !== expectedHeadings[index])
  ) {
    throw new Error("Read-air output contains an unsupported or misplaced heading.");
  }
  assertAirKnowledgeSize(content);
  return content;
}

function assertAirKnowledgeSize(content: string) {
  if (Buffer.byteLength(content, "utf8") > AIR_KNOWLEDGE_MAX_BYTES) {
    throw new Error("AIR.md exceeds the 64 KiB limit.");
  }
}

function revision(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function readOptional(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

async function restoreCancelledAirWrite(
  filePath: string,
  expectedRevision: string,
  previousRaw: string
) {
  const currentRaw = await readOptional(filePath);
  if (revision(currentRaw) !== expectedRevision) {
    throw Object.assign(
      new Error("AIR.md changed before a cancelled write could be restored."),
      { code: "AIR_CANCEL_ROLLBACK_CONFLICT" }
    );
  }
  const temporary = `${filePath}.rollback-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, previousRaw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    const latestRaw = await readOptional(filePath);
    if (revision(latestRaw) !== expectedRevision) {
      throw Object.assign(
        new Error("AIR.md changed before a cancelled write could be restored."),
        { code: "AIR_CANCEL_ROLLBACK_CONFLICT" }
      );
    }
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
