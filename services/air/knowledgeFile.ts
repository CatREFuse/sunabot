import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../../src/config.js";
import type { AppConfig } from "../../src/types.js";
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
  content: string
) {
  const normalized = normalizeAirKnowledge(content);
  const current = await readAirKnowledge(config);
  if (current.revision !== expectedRevision) return { status: "conflict" as const, current };
  if (current.content === normalized) return { status: "unchanged" as const, current };

  const temporary = `${current.filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(current.filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${normalized}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    const latest = await readAirKnowledge(config);
    if (latest.revision !== expectedRevision) {
      await fs.rm(temporary, { force: true });
      return { status: "conflict" as const, current: latest };
    }
    await fs.rename(temporary, current.filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const updated = await readAirKnowledge(config);
  return { status: "updated" as const, current: updated };
}

export function normalizeAirKnowledge(value: string) {
  const content = value.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (!content) throw new Error("Read-air output is empty.");
  if (!content.startsWith("# 场域知识")) throw new Error("Read-air output must start with '# 场域知识'.");
  for (const heading of ["使用边界", "当前中文互联网公共语境", "会话场域"]) {
    if (!content.includes(`## ${heading}`)) throw new Error(`Read-air output is missing '${heading}'.`);
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
