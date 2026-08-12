import fs from "node:fs/promises";
import path from "node:path";
import type { CodexCoordinatorSettings } from "./sessionCoordinatorTypes.js";
import type { ToolJobRecord } from "./sessionStore.js";

interface CodexSensitivePathInput {
  job: ToolJobRecord;
  settings: CodexCoordinatorSettings;
  resultFile?: string;
}

export async function codexResultSensitivePaths(
  input: CodexSensitivePathInput
): Promise<string[]> {
  const candidates = [
    ...absolutePathVariants(input.resultFile),
    ...absolutePathVariants(input.settings.jobRoot),
    ...absolutePathVariants(path.resolve(input.settings.jobRoot, input.job.id)),
    ...absolutePathVariants(input.settings.workspacePath),
    ...controlWorkspacePaths(input.job.arguments),
    ...absolutePathVariants(input.settings.authFile),
    ...absolutePathVariants(input.settings.executable)
  ];
  for (const candidate of candidates.slice()) {
    const realPath = await fs.realpath(candidate).catch(() => undefined);
    if (realPath) candidates.push(realPath);
  }
  return [...new Set(candidates)].sort((left, right) => right.length - left.length);
}

export function redactCodexSensitivePaths(
  value: string,
  sensitivePaths: readonly string[]
) {
  return sensitivePaths.reduce(
    (current, sensitivePath) => current.split(sensitivePath).join("受控任务目录"),
    value
  );
}

export function sanitizeCodexArtifactError(
  error: unknown,
  sensitivePaths: readonly string[]
) {
  const rawCode = typeof (error as { code?: unknown } | undefined)?.code === "string"
    ? String((error as { code: string }).code)
    : "codex_artifact_publish_failed";
  const code = /^codex_artifact_[a-z_]+$/u.test(rawCode)
    ? rawCode
    : "codex_artifact_publish_failed";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactCodexSensitivePaths(rawMessage, sensitivePaths);
  return Object.assign(new Error(message), { code });
}

function controlWorkspacePaths(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).workspace_path;
  if (typeof raw !== "string" || raw.length > 4_096) return [];
  return absolutePathVariants(raw.trim());
}

function absolutePathVariants(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4_096) return [];
  const candidate = value;
  if (
    !path.isAbsolute(candidate)
    && !path.posix.isAbsolute(candidate)
    && !path.win32.isAbsolute(candidate)
  ) return [];
  const windowsOnly = path.win32.isAbsolute(candidate)
    && !path.isAbsolute(candidate)
    && !path.posix.isAbsolute(candidate);
  const normalized = windowsOnly ? path.win32.normalize(candidate) : path.normalize(candidate);
  const resolved = windowsOnly ? normalized : path.resolve(candidate);
  const root = windowsOnly ? path.win32.parse(candidate).root : path.parse(candidate).root;
  return [...new Set([candidate, normalized, resolved])]
    .filter((item) => item.length > root.length);
}
