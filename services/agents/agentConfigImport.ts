import { createHash } from "node:crypto";
import path from "node:path";
import { AGENT_RESOURCE_LAYOUT } from "../../packages/platform/agentResourceLayout.js";
import * as yauzl from "yauzl";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  MAX_SELFIE_REFERENCE_BYTES,
  MAX_SELFIE_STORED_REFERENCE_IMAGES,
  SelfieReferenceCatalogError,
  loadSelfieReferenceCatalog,
  readSelfieReferenceManifest,
  writeSelfieReferenceCatalog
} from "../media/public.js";

const MAX_IMPORT_FILES = 48;
const MAX_IMPORT_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_IMPORT_TEXT_BYTES = 512 * 1024;
const PERSONA_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "PREFERENCE.md",
  "DIALOGUE_STYLE_EXAMPLES.md",
  "USER.md",
  "RELATION.md",
  "AIR.md",
  "DIRECTOR_SEED.md"
] as const;

export interface AgentConfigImportFileInput {
  path: string;
  dataBase64: string;
}

export type AgentConfigImportInput =
  | { source: "folder"; files: AgentConfigImportFileInput[] }
  | { source: "zip"; fileName: string; dataBase64: string };

export interface AgentConfigImportPlan {
  source: "folder" | "zip";
  files: ReadonlyMap<string, Buffer>;
  included: string[];
  missing: string[];
}

export interface AgentConfigImportRules {
  finalPromptFiles: readonly string[];
  systemPromptFiles: readonly string[];
}

export async function prepareAgentConfigImport(
  input: AgentConfigImportInput,
  rules: AgentConfigImportRules
): Promise<AgentConfigImportPlan> {
  const files = input.source === "folder"
    ? decodeFolderFiles(input.files)
    : await decodeZipFiles(input.fileName, input.dataBase64);
  const normalized = normalizePackageRoot(files, rules);
  validatePackageFiles(normalized, rules);
  const missing = missingComponents(normalized, rules);
  return {
    source: input.source,
    files: normalized,
    included: [...normalized.keys()].sort(),
    missing
  };
}

export function readImportedManifest(plan: AgentConfigImportPlan) {
  const bytes = plan.files.get("agent.json");
  if (!bytes) return undefined;
  return parseJson(bytes, "AGENT_IMPORT_MANIFEST_INVALID", "Agent 配置文件无效。");
}

export async function materializeAgentConfigImport(
  directory: string,
  plan: AgentConfigImportPlan,
  options: { skipAvatar?: boolean } = {}
) {
  for (const [relativePath, bytes] of plan.files) {
    if (relativePath === "agent.json") continue;
    if (options.skipAvatar && relativePath.startsWith("assets/avatar.")) continue;
    const target = relativePath.startsWith("selfie/")
      ? path.join(directory, AGENT_RESOURCE_LAYOUT.selfie, ...relativePath.slice("selfie/".length).split("/"))
      : path.join(directory, ...relativePath.split("/"));
    await fsWriteFile(target, bytes);
  }
  await normalizeImportedSelfies(directory, plan.files);
}

function decodeFolderFiles(value: unknown): Map<string, Buffer> {
  if (!Array.isArray(value) || !value.length) {
    invalid("AGENT_IMPORT_EMPTY", "请选择包含 Agent 配置的文件夹。");
  }
  if (value.length > MAX_IMPORT_FILES) {
    invalid("AGENT_IMPORT_FILE_LIMIT", `配置包最多包含 ${MAX_IMPORT_FILES} 个文件。`);
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      invalid("AGENT_IMPORT_FILE_INVALID", "配置包文件无效。");
    }
    const record = item as Record<string, unknown>;
    const filePath = normalizeRelativePath(record.path);
    const bytes = decodeBase64(record.dataBase64, "AGENT_IMPORT_FILE_INVALID", "配置包文件无效。");
    if (files.has(filePath)) invalid("AGENT_IMPORT_DUPLICATE_FILE", `配置包包含重复文件：${filePath}`);
    total += bytes.byteLength;
    if (total > MAX_IMPORT_UNCOMPRESSED_BYTES) {
      invalid("AGENT_IMPORT_TOO_LARGE", "配置包内容超过 80 MiB 限制。");
    }
    files.set(filePath, bytes);
  }
  return files;
}

async function decodeZipFiles(fileName: unknown, dataBase64: unknown): Promise<Map<string, Buffer>> {
  if (typeof fileName !== "string" || !fileName.toLowerCase().endsWith(".zip")) {
    invalid("AGENT_IMPORT_ARCHIVE_INVALID", "请选择 ZIP 配置包。");
  }
  const bytes = decodeBase64(dataBase64, "AGENT_IMPORT_ARCHIVE_INVALID", "ZIP 配置包无效。");
  if (bytes.byteLength > MAX_IMPORT_ARCHIVE_BYTES) {
    invalid("AGENT_IMPORT_ARCHIVE_TOO_LARGE", "ZIP 配置包超过 64 MiB 限制。");
  }
  const zip = await openZip(bytes);
  const files = new Map<string, Buffer>();
  let total = 0;
  try {
    for await (const entry of entries(zip)) {
      const isDirectory = entry.fileName.endsWith("/");
      const entryPath = normalizeRelativePath(entry.fileName, isDirectory);
      validateZipEntryType(entry, isDirectory);
      if (entryPath.endsWith("/")) continue;
      if (files.size >= MAX_IMPORT_FILES) {
        invalid("AGENT_IMPORT_FILE_LIMIT", `配置包最多包含 ${MAX_IMPORT_FILES} 个文件。`);
      }
      if (entry.uncompressedSize > MAX_IMPORT_UNCOMPRESSED_BYTES || total + entry.uncompressedSize > MAX_IMPORT_UNCOMPRESSED_BYTES) {
        invalid("AGENT_IMPORT_TOO_LARGE", "配置包内容超过 80 MiB 限制。");
      }
      if (files.has(entryPath)) invalid("AGENT_IMPORT_DUPLICATE_FILE", `配置包包含重复文件：${entryPath}`);
      const content = await readZipEntry(zip, entry);
      total += content.byteLength;
      if (total > MAX_IMPORT_UNCOMPRESSED_BYTES) invalid("AGENT_IMPORT_TOO_LARGE", "配置包内容超过 80 MiB 限制。");
      files.set(entryPath, content);
    }
  } finally {
    zip.close();
  }
  if (!files.size) invalid("AGENT_IMPORT_EMPTY", "ZIP 配置包不包含可导入文件。");
  return files;
}

function normalizePackageRoot(files: Map<string, Buffer>, rules: AgentConfigImportRules) {
  if ([...files.keys()].some((fileName) => isAllowedPath(fileName, rules))) return files;
  const first = [...files.keys()][0]?.split("/")[0];
  if (!first || ![...files.keys()].every((fileName) => fileName.startsWith(`${first}/`))) return files;
  const unwrapped = new Map<string, Buffer>();
  for (const [fileName, bytes] of files) {
    const next = fileName.slice(first.length + 1);
    if (!next || unwrapped.has(next)) invalid("AGENT_IMPORT_DUPLICATE_FILE", "配置包包含重复文件。");
    unwrapped.set(next, bytes);
  }
  return unwrapped;
}

function validatePackageFiles(files: ReadonlyMap<string, Buffer>, rules: AgentConfigImportRules) {
  if (!files.size) invalid("AGENT_IMPORT_EMPTY", "配置包不包含可导入文件。");
  const avatars = [...files.keys()].filter((fileName) => fileName.startsWith("assets/avatar."));
  if (avatars.length > 1) invalid("AGENT_IMPORT_AVATAR_CONFLICT", "配置包只能包含一个头像文件。");
  for (const [fileName, bytes] of files) {
    if (!isAllowedPath(fileName, rules)) {
      invalid("AGENT_IMPORT_UNKNOWN_FILE", `配置包不支持文件：${fileName}`);
    }
    if (isTextFile(fileName)) {
      if (bytes.byteLength > MAX_IMPORT_TEXT_BYTES) {
        invalid("AGENT_IMPORT_TEXT_TOO_LARGE", `配置文件过大：${fileName}`);
      }
      decodeUtf8(bytes, "AGENT_IMPORT_TEXT_INVALID", `配置文件不是有效 UTF-8：${fileName}`);
      if (fileName.endsWith(".json")) {
        parseJson(bytes, "AGENT_IMPORT_JSON_INVALID", `配置文件不是有效 JSON：${fileName}`);
      }
    } else if (fileName.startsWith("selfie/")) {
      if (bytes.byteLength > MAX_SELFIE_REFERENCE_BYTES) {
        invalid("AGENT_IMPORT_SELFIE_TOO_LARGE", `自拍参考图超过 8 MiB：${fileName}`);
      }
      assertImage(bytes, "AGENT_IMPORT_SELFIE_INVALID", `自拍参考图格式无效：${fileName}`);
    } else if (fileName.startsWith("assets/")) {
      assertImage(bytes, "AGENT_IMPORT_AVATAR_INVALID", "头像格式无效。");
    }
  }
}

function missingComponents(files: ReadonlyMap<string, Buffer>, rules: AgentConfigImportRules) {
  const missing: string[] = [];
  if (!files.has("agent.json")) missing.push("Agent 配置");
  for (const fileName of PERSONA_FILES) {
    if (!files.has(fileName)) missing.push(`人格文件：${fileName}`);
  }
  for (const fileName of rules.finalPromptFiles) {
    if (!files.has(fileName)) missing.push(`提示词：${fileName}`);
  }
  if (!["assets/avatar.png", "assets/avatar.jpg", "assets/avatar.webp"].some((fileName) => files.has(fileName))) {
    missing.push("头像");
  }
  if (![...files.keys()].some((fileName) => (
    fileName.startsWith("selfie/")
    && fileName !== "selfie/references.json"
    && fileName !== "selfie/references.jsonl"
  ))) {
    missing.push("自拍参考图");
  }
  if (![...files.keys()].some((fileName) => fileName.startsWith("system-prompts/"))) {
    missing.push("系统提示词覆盖");
  }
  return missing;
}

function isAllowedPath(fileName: string, rules: AgentConfigImportRules) {
  if (fileName === "agent.json" || PERSONA_FILES.includes(fileName as typeof PERSONA_FILES[number])) return true;
  if (rules.finalPromptFiles.includes(fileName)) return true;
  if (rules.systemPromptFiles.some((name) => fileName === `system-prompts/${name}`)) return true;
  if (/^assets\/avatar\.(?:png|jpg|webp)$/.test(fileName)) return true;
  if (fileName === "selfie/references.json" || fileName === "selfie/references.jsonl") return true;
  return /^selfie\/[A-Za-z0-9][A-Za-z0-9._ -]{0,239}\.(?:png|jpg|jpeg|webp)$/.test(fileName);
}

function isTextFile(fileName: string) {
  return !fileName.startsWith("assets/") && !(/^selfie\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(fileName));
}

function normalizeRelativePath(value: unknown, directory = false) {
  if (typeof value !== "string" || !value || hasControlCharacter(value) || hasLoneSurrogate(value) || value !== value.normalize("NFC")) {
    invalid("AGENT_IMPORT_PATH_INVALID", "配置包路径无效。");
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    invalid("AGENT_IMPORT_PATH_INVALID", "配置包路径无效。");
  }
  const trimmed = directory ? value.slice(0, -1) : value;
  if (!trimmed || trimmed.split("/").some((part) => !part || part === "." || part === "..")) {
    invalid("AGENT_IMPORT_PATH_INVALID", "配置包路径无效。");
  }
  return directory ? `${trimmed}/` : trimmed;
}

function decodeBase64(value: unknown, code: string, message: string) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid(code, message);
  const bytes = Buffer.from(value, "base64");
  if (!bytes.byteLength || bytes.toString("base64") !== value) invalid(code, message);
  return bytes;
}

function decodeUtf8(bytes: Buffer, code: string, message: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid(code, message);
  }
}

function parseJson(bytes: Buffer, code: string, message: string) {
  try {
    return JSON.parse(decodeUtf8(bytes, code, message));
  } catch {
    invalid(code, message);
  }
}

async function normalizeImportedSelfies(directory: string, files: ReadonlyMap<string, Buffer>) {
  const imported = [...files].filter(([fileName]) => /^selfie\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(fileName));
  if (imported.length > MAX_SELFIE_STORED_REFERENCE_IMAGES) {
    invalid("AGENT_IMPORT_SELFIE_LIMIT", `自拍参考图最多保留 ${MAX_SELFIE_STORED_REFERENCE_IMAGES} 张。`);
  }
  const identities = imported.map(([fileName, bytes]) => ({
    id: createHash("sha256").update(bytes).digest("hex"),
    fileName: path.basename(fileName)
  }));
  const selfieDirectory = path.join(directory, AGENT_RESOURCE_LAYOUT.selfie);
  let manifest;
  try {
    manifest = await readSelfieReferenceManifest(selfieDirectory);
  } catch (error) {
    if (error instanceof SelfieReferenceCatalogError) {
      invalid("AGENT_IMPORT_SELFIE_MANIFEST_INVALID", "自拍参考图清单无效。");
    }
    throw error;
  }
  if (manifest) {
    const fileNames = new Set(identities.map((item) => item.fileName));
    if (manifest.references.length !== identities.length || manifest.references.some((item) => !fileNames.has(item.fileName))) {
      invalid("AGENT_IMPORT_SELFIE_MANIFEST_INVALID", "自拍参考图清单与文件不一致。");
    }
    for (const item of manifest.references) {
      const identity = identities.find((candidate) => candidate.fileName === item.fileName);
      if (!identity || identity.id !== item.id) {
        invalid("AGENT_IMPORT_SELFIE_MANIFEST_INVALID", "自拍参考图清单与文件内容不一致。");
      }
    }
  }
  if (!imported.length) return;
  let catalog;
  try {
    catalog = await loadSelfieReferenceCatalog(selfieDirectory, identities);
  } catch (error) {
    if (error instanceof SelfieReferenceCatalogError) {
      invalid("AGENT_IMPORT_SELFIE_MANIFEST_INVALID", "自拍参考图清单无效。");
    }
    throw error;
  }
  if (catalog.needsWrite) await writeSelfieReferenceCatalog(selfieDirectory, catalog.references);
}

async function fsWriteFile(target: string, bytes: Buffer) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, bytes, { mode: 0o600 });
}

function assertImage(bytes: Buffer, code: string, message: string) {
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const webp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!png && !jpeg && !webp) invalid(code, message);
}

function validateZipEntryType(entry: yauzl.Entry, isDirectory: boolean) {
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0o170000;
  const expectedType = isDirectory ? 0o040000 : 0o100000;
  if (type && type !== expectedType) {
    invalid("AGENT_IMPORT_ARCHIVE_LINK", "ZIP 配置包不能包含链接或特殊文件。");
  }
}

function openZip(bytes: Buffer) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(new ServiceError(400, "AGENT_IMPORT_ARCHIVE_INVALID", "ZIP 配置包无效。"));
      else resolve(zip);
    });
  });
}

async function* entries(zip: yauzl.ZipFile): AsyncGenerator<yauzl.Entry> {
  const queue: yauzl.Entry[] = [];
  let done = false;
  let failure: unknown;
  zip.on("entry", (entry: yauzl.Entry) => queue.push(entry));
  zip.once("end", () => { done = true; });
  zip.once("error", (error) => { failure = error; done = true; });
  zip.readEntry();
  while (!done || queue.length) {
    const entry = queue.shift();
    if (entry) {
      yield entry;
      zip.readEntry();
      continue;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (failure) throw new ServiceError(400, "AGENT_IMPORT_ARCHIVE_INVALID", "ZIP 配置包无效。");
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new ServiceError(400, "AGENT_IMPORT_ARCHIVE_INVALID", "ZIP 配置包无效。"));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_IMPORT_UNCOMPRESSED_BYTES) {
          stream.destroy(new Error("too large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("error", () => reject(new ServiceError(400, "AGENT_IMPORT_ARCHIVE_INVALID", "ZIP 配置包无效。")));
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function hasLoneSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function invalid(code: string, message: string): never {
  throw new ServiceError(400, code, message);
}
