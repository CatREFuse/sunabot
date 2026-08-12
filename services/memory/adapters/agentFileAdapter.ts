import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import { resolveProjectPath } from "../../../packages/platform/projectPaths.js";
import { normalizeText } from "../domain/normalizers.js";
import { readOptional } from "./legacyJsonl.js";

export async function readAgentTextFile(config: AppConfig, fileName: string, fallback = "") {
  const filePath = resolveAgentFilePath(config, fileName);
  const content = await readOptional(filePath);
  return content.trim() || fallback;
}

export async function ensureAgentTextFile(config: AppConfig, fileName: string, content: string) {
  const filePath = resolveAgentFilePath(config, fileName);
  const current = await readOptional(filePath);
  if (current.trim()) return filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${content.trim()}\n`, "utf8");
  return filePath;
}

export function resolveAgentFilePath(config: AppConfig, fileName: string) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("Agent workspace is not configured.");
  const workspaceRoot = path.resolve(workspace);
  const resolved = path.resolve(workspaceRoot, normalizeText(fileName));
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Agent file must be inside the agent workspace.");
  }
  return resolved;
}
