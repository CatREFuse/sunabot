import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../../src/config.js";
import type { AppConfig } from "../../src/types.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";

export type PromptWorkspaceScope = "persona" | "system";

export function resolvePromptWorkspace(config: AppConfig, scope: PromptWorkspaceScope) {
  const configured = scope === "system"
    ? config.persona.systemPromptWorkspace
    : config.persona.agentWorkspace;
  const workspace = resolveProjectPath(configured);
  if (!workspace) throw new Error(`${scope === "system" ? "System prompt" : "Agent"} workspace is not configured.`);
  return path.resolve(workspace);
}

export function resolvePromptFilePath(config: AppConfig, scope: PromptWorkspaceScope, fileName: string) {
  const workspace = resolvePromptWorkspace(config, scope);
  const resolved = path.resolve(workspace, fileName.trim());
  if (resolved === workspace || !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Prompt file must be inside its workspace.");
  }
  return resolved;
}

export async function resolveSafePromptFilePath(
  config: AppConfig,
  scope: PromptWorkspaceScope,
  fileName: string
) {
  const workspace = resolvePromptWorkspace(config, scope);
  const filePath = resolvePromptFilePath(config, scope, fileName);
  await assertNoSymbolicLink(workspace, filePath);
  return filePath;
}

export async function readPromptTextFile(
  config: AppConfig,
  scope: PromptWorkspaceScope,
  fileName: string,
  fallback = ""
) {
  const content = await readOptional(await resolveSafePromptFilePath(config, scope, fileName));
  return content.trim() || fallback;
}

export async function ensurePromptTextFile(
  config: AppConfig,
  scope: PromptWorkspaceScope,
  fileName: string,
  content: string
) {
  const filePath = await resolveSafePromptFilePath(config, scope, fileName);
  const current = await readOptional(filePath);
  if (current.trim()) return filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

const GROUP_THREAD_CONTEXT_VARIABLE = "conversation.group.thread_context";

export async function migrateGroupReplyThreadContextVariable(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    `.${path.basename(fileName)}.thread-context-v1`
  );
  if (await readOptional(markerPath)) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateGroupReplyThreadContextTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, "thread-context-v1\n");
  return migrated !== template;
}

export function migrateGroupReplyThreadContextTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (extractPromptVariables(JSON.stringify(template)).includes(GROUP_THREAD_CONTEXT_VARIABLE)) {
    return template;
  }
  const messages = [...template.messages];
  const currentInputIndex = messages.findIndex((message) => (
    typeof message === "object"
    && message.role === "user"
    && typeof message.content === "string"
    && extractPromptVariables(message.content).includes("user.input")
  ));
  const finalUserIndex = findLastIndex(messages, (message) => (
    typeof message === "object" && message.role === "user"
  ));
  const insertionIndex = currentInputIndex >= 0
    ? currentInputIndex
    : finalUserIndex >= 0 ? finalUserIndex : messages.length;
  messages.splice(insertionIndex, 0, {
    role: "developer",
    content: `<thread_context>@{${GROUP_THREAD_CONTEXT_VARIABLE}}</thread_context>`
  });
  return { ...template, messages };
}

async function assertNoSymbolicLink(workspace: string, filePath: string) {
  const relative = path.relative(workspace, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw promptPathError();
  }
  const paths = [workspace];
  let current = workspace;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  for (const [index, candidate] of paths.entries()) {
    try {
      const stat = await fs.lstat(candidate);
      const leaf = index === paths.length - 1;
      if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) throw promptPathError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

function promptPathError() {
  return Object.assign(new Error("Prompt path contains an invalid or symbolic-link component."), {
    code: "PROMPT_PATH_INVALID"
  });
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWriteText(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
