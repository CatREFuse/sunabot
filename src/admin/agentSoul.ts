import crypto from "node:crypto";
import path from "node:path";
import {
  AGENT_SOUL_FILE_EXTENSION,
  AGENT_SOUL_SCHEMA,
  AGENT_SOUL_VERSION,
  type AgentSoulDocument,
  type AgentSoulFile,
  type AgentSoulImportRequest,
  type AgentSoulPreview,
  type AgentSoulUpload,
  type AppConfig
} from "../../packages/contracts/admin/public.js";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import { AdminApiError, badRequest, conflict } from "./errors.js";
import { AGENT_FILE_DEFINITIONS, type AgentFileRepository } from "./agentFiles.js";

export const MAX_AGENT_SOUL_BYTES = 3 * 1024 * 1024;

export interface AgentSoulServiceOptions {
  registry: Pick<AgentRegistry, "config" | "get">;
  repositoryFor(agentId: string): AgentFileRepository;
}

export class AgentSoulService {
  constructor(private readonly options: AgentSoulServiceOptions) {}

  async export(agentId: string) {
    const [agent, config] = await Promise.all([
      this.options.registry.get(agentId),
      this.options.registry.config(agentId)
    ]);
    const snapshot = await this.options.repositoryFor(agentId).readBatch(config, "persona");
    const document: AgentSoulDocument = {
      schema: AGENT_SOUL_SCHEMA,
      version: AGENT_SOUL_VERSION,
      source: { agentId: agent.id, name: agent.name },
      files: snapshot.files.map(({ id, fileName, kind, content }) => ({
        id,
        fileName,
        kind,
        content,
        sha256: contentSha256(content)
      }))
    };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    if (bytes.byteLength > MAX_AGENT_SOUL_BYTES) {
      throw new AdminApiError(413, "AGENT_SOUL_TOO_LARGE", "灵魂文件超过 3 MiB 限制。");
    }
    return {
      fileName: `${agent.id}${AGENT_SOUL_FILE_EXTENSION}`,
      bytes,
      packageSha256: sha256(bytes)
    };
  }

  async preview(agentId: string, input: unknown): Promise<AgentSoulPreview> {
    const upload = parseUpload(input);
    const parsed = parseSoulUpload(upload);
    const config = await this.options.registry.config(agentId);
    const files = validateSoulDocument(parsed.document, config);
    const snapshot = await this.options.repositoryFor(agentId).inspectBatch(
      files.map(({ id, content }) => ({ id, content })),
      config,
      "persona"
    );
    const currentById = new Map(snapshot.files.map((file) => [file.id, file]));
    return {
      schema: AGENT_SOUL_SCHEMA,
      version: AGENT_SOUL_VERSION,
      source: parsed.document.source,
      targetAgentId: agentId,
      packageSha256: parsed.packageSha256,
      targetRevision: snapshot.revision,
      files: files.map(({ id, fileName, kind, content }) => ({
        id,
        fileName,
        kind,
        change: currentById.get(id)?.content === content ? "unchanged" : "replace"
      }))
    };
  }

  async apply(agentId: string, input: unknown) {
    const request = parseImportRequest(input);
    const parsed = parseSoulUpload(request);
    if (request.packageSha256 !== parsed.packageSha256) {
      conflict("AGENT_SOUL_PACKAGE_CHANGED", "灵魂文件已变化，请重新预览。");
    }
    const config = await this.options.registry.config(agentId);
    const files = validateSoulDocument(parsed.document, config);
    const saved = await this.options.repositoryFor(agentId).putBatch(
      files.map(({ id, content }) => ({ id, content })),
      request.targetRevision,
      config,
      "persona"
    );
    return {
      ok: true,
      imported: saved.files.length,
      packageSha256: parsed.packageSha256,
      targetRevision: saved.revision
    };
  }
}

function parseUpload(value: unknown): AgentSoulUpload {
  const record = exactRecord(value, ["fileName", "dataBase64"], "AGENT_SOUL_UPLOAD_INVALID", "灵魂文件无效。");
  if (typeof record.fileName !== "string" || typeof record.dataBase64 !== "string") {
    badRequest("AGENT_SOUL_UPLOAD_INVALID", "灵魂文件无效。");
  }
  return { fileName: record.fileName, dataBase64: record.dataBase64 };
}

function parseImportRequest(value: unknown): AgentSoulImportRequest {
  const record = exactRecord(
    value,
    ["fileName", "dataBase64", "packageSha256", "targetRevision"],
    "AGENT_SOUL_IMPORT_INVALID",
    "灵魂文件导入请求无效。"
  );
  if (
    typeof record.fileName !== "string"
    || typeof record.dataBase64 !== "string"
    || typeof record.packageSha256 !== "string"
    || typeof record.targetRevision !== "string"
    || !isSha256(record.packageSha256)
    || !isSha256(record.targetRevision)
  ) {
    badRequest("AGENT_SOUL_IMPORT_INVALID", "灵魂文件导入请求无效。");
  }
  return {
    fileName: record.fileName,
    dataBase64: record.dataBase64,
    packageSha256: record.packageSha256,
    targetRevision: record.targetRevision
  };
}

function parseSoulUpload(upload: AgentSoulUpload) {
  if (
    !upload.fileName.endsWith(AGENT_SOUL_FILE_EXTENSION)
    || path.basename(upload.fileName) !== upload.fileName
    || upload.fileName !== upload.fileName.normalize("NFC")
    || hasControlCharacter(upload.fileName)
  ) {
    badRequest("AGENT_SOUL_FILE_NAME_INVALID", `请选择 ${AGENT_SOUL_FILE_EXTENSION} 文件。`);
  }
  if (!upload.dataBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.dataBase64)) {
    badRequest("AGENT_SOUL_ENCODING_INVALID", "灵魂文件编码无效。");
  }
  const bytes = Buffer.from(upload.dataBase64, "base64");
  if (!bytes.byteLength || bytes.toString("base64") !== upload.dataBase64) {
    badRequest("AGENT_SOUL_ENCODING_INVALID", "灵魂文件编码无效。");
  }
  if (bytes.byteLength > MAX_AGENT_SOUL_BYTES) {
    throw new AdminApiError(413, "AGENT_SOUL_TOO_LARGE", "灵魂文件超过 3 MiB 限制。");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    badRequest("AGENT_SOUL_UTF8_INVALID", "灵魂文件不是有效 UTF-8。");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    badRequest("AGENT_SOUL_JSON_INVALID", "灵魂文件不是有效 JSON。");
  }
  return { document: parseDocument(value), packageSha256: sha256(bytes) };
}

function parseDocument(value: unknown): AgentSoulDocument {
  const root = exactRecord(value, ["schema", "version", "source", "files"], "AGENT_SOUL_SCHEMA_INVALID", "灵魂文件结构无效。");
  if (root.schema !== AGENT_SOUL_SCHEMA) badRequest("AGENT_SOUL_SCHEMA_INVALID", "灵魂文件 schema 无效。");
  if (root.version !== AGENT_SOUL_VERSION) badRequest("AGENT_SOUL_VERSION_UNSUPPORTED", "灵魂文件版本不受支持。");
  const source = exactRecord(root.source, ["agentId", "name"], "AGENT_SOUL_SOURCE_INVALID", "灵魂文件来源无效。");
  if (
    typeof source.agentId !== "string"
    || !/^[a-z][a-z0-9-]{1,31}$/.test(source.agentId)
    || typeof source.name !== "string"
    || !source.name.trim()
    || [...source.name].length > 80
    || source.name !== source.name.normalize("NFC")
    || hasControlCharacter(source.name)
    || hasLoneSurrogate(source.name)
  ) {
    badRequest("AGENT_SOUL_SOURCE_INVALID", "灵魂文件来源无效。");
  }
  if (!Array.isArray(root.files)) badRequest("AGENT_SOUL_FILES_INVALID", "灵魂文件清单无效。");
  const files = root.files.map((item) => parseFile(item));
  return {
    schema: AGENT_SOUL_SCHEMA,
    version: AGENT_SOUL_VERSION,
    source: { agentId: source.agentId, name: source.name },
    files
  };
}

function parseFile(value: unknown): AgentSoulFile {
  const file = exactRecord(
    value,
    ["id", "fileName", "kind", "content", "sha256"],
    "AGENT_SOUL_FILE_INVALID",
    "灵魂文件条目无效。"
  );
  if (
    typeof file.id !== "string"
    || !/^[a-z][a-z0-9._-]{1,95}$/.test(file.id)
    || typeof file.fileName !== "string"
    || !file.fileName
    || [...file.fileName].length > 256
    || file.fileName !== file.fileName.normalize("NFC")
    || hasControlCharacter(file.fileName)
    || hasLoneSurrogate(file.fileName)
    || (file.kind !== "fragment" && file.kind !== "final")
    || typeof file.content !== "string"
    || hasLoneSurrogate(file.content)
    || typeof file.sha256 !== "string"
    || !isSha256(file.sha256)
  ) {
    badRequest("AGENT_SOUL_FILE_INVALID", "灵魂文件条目无效。");
  }
  return {
    id: file.id,
    fileName: file.fileName,
    kind: file.kind,
    content: file.content,
    sha256: file.sha256
  };
}

function validateSoulDocument(document: AgentSoulDocument, config: AppConfig) {
  const definitions = AGENT_FILE_DEFINITIONS.filter((definition) => definition.scope === "persona");
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const filesById = new Map<string, AgentSoulFile>();
  for (const file of document.files) {
    if (filesById.has(file.id)) badRequest("AGENT_SOUL_FILE_DUPLICATE", `灵魂文件条目重复：${file.id}`);
    if (!definitionById.has(file.id)) badRequest("AGENT_SOUL_FILE_UNKNOWN", `灵魂文件包含未知条目：${file.id}`);
    filesById.set(file.id, file);
  }
  if (filesById.size !== definitions.length) {
    const missing = definitions.find((definition) => !filesById.has(definition.id));
    badRequest("AGENT_SOUL_FILE_MISSING", `灵魂文件缺少条目：${missing?.id ?? "unknown"}`);
  }
  return definitions.map((definition) => {
    const file = filesById.get(definition.id)!;
    const expectedFileName = definition.fileName(config);
    if (file.fileName !== expectedFileName) {
      badRequest("AGENT_SOUL_FILE_NAME_MISMATCH", `灵魂文件名与当前版本不匹配：${file.id}`);
    }
    if (file.kind !== definition.kind) {
      badRequest("AGENT_SOUL_FILE_KIND_MISMATCH", `灵魂文件类型与当前版本不匹配：${file.id}`);
    }
    if (contentSha256(file.content) !== file.sha256) {
      badRequest("AGENT_SOUL_FILE_HASH_MISMATCH", `灵魂文件摘要不匹配：${file.id}`);
    }
    return file;
  });
}

function exactRecord(value: unknown, keys: readonly string[], code: string, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) badRequest(code, message);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) badRequest(code, message);
  return record;
}

function contentSha256(content: string) {
  return sha256(Buffer.from(content, "utf8"));
}

function sha256(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}

function hasControlCharacter(value: string) {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function hasLoneSurrogate(value: string) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
