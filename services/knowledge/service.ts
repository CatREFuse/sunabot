import crypto from "node:crypto";
import fsConstants from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { getWorkspacePath, resolveProjectPath } from "../../packages/platform/projectPaths.js";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { chunkKnowledgeDocument } from "./chunking.js";
import { knowledgeFtsQuery, tokenizeKnowledgeText } from "./tokenizer.js";
import type {
  KnowledgeChunk,
  KnowledgeDirectoryIndex,
  KnowledgeDocument,
  KnowledgeDocumentFormat,
  KnowledgeSearchInput,
  KnowledgeSearchMatch,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  KnowledgeUploadInput
} from "./types.js";
import { AGENT_RESOURCE_LAYOUT } from "../../packages/platform/agentResourceLayout.js";

const INDEX_SCHEMA_VERSION = "1";
export const KNOWLEDGE_DIRECTORY_INDEX_FILE = "index.json";
const PARSER_REVISION = "1";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_DEPTH = 32;
const MAX_RESULT_CONTENT_CHARS = 4_000;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const locks = new Map<string, Promise<void>>();

type SqlRow = Record<string, unknown>;
type BigIntStats = Awaited<ReturnType<typeof fs.stat>> & {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

interface SourceFile {
  path: string;
  absolutePath: string;
  format: KnowledgeDocumentFormat;
  stats: BigIntStats;
}

interface ParsedSourceFile extends SourceFile {
  sha256?: string;
  chunks: KnowledgeChunk[];
  status: "indexed" | "error";
  errorCode?: string;
}

export interface KnowledgeBaseServiceOptions {
  sourceRoot: string;
  indexPath: string;
  now?: () => Date;
}

export class KnowledgeBaseService {
  private readonly sourceRoot: string;
  private readonly indexPath: string;
  private readonly now: () => Date;

  constructor(options: KnowledgeBaseServiceOptions) {
    this.sourceRoot = path.resolve(options.sourceRoot);
    this.indexPath = path.resolve(options.indexPath);
    this.now = options.now ?? (() => new Date());
  }

  list() {
    return this.lock(() => this.syncUnlocked());
  }

  reindex() {
    return this.lock(() => this.syncUnlocked({ force: true }));
  }

  search(input: KnowledgeSearchInput = {}): Promise<KnowledgeSearchResult> {
    return this.lock(async () => {
      const query = normalizeQuery(input.query);
      if (!query) return { ok: false, query, matches: [], error: "请输入知识库检索内容。" };
      const ftsQuery = knowledgeFtsQuery(query);
      if (!ftsQuery) return { ok: false, query, matches: [], error: "检索内容没有可用关键词。" };
      const snapshot = await this.syncUnlocked();
      const database = await this.openIndex();
      try {
        const rows = database.prepare(`
          SELECT
            knowledge_chunks.file_path,
            knowledge_files.format,
            knowledge_chunks.ordinal,
            knowledge_chunks.start_line,
            knowledge_chunks.end_line,
            knowledge_chunks.content,
            bm25(knowledge_chunks_fts, 2.0, 1.0) AS rank
          FROM knowledge_chunks_fts
          JOIN knowledge_chunks ON knowledge_chunks.id = knowledge_chunks_fts.rowid
          JOIN knowledge_files ON knowledge_files.path = knowledge_chunks.file_path
          WHERE knowledge_chunks_fts MATCH ?
          ORDER BY rank, knowledge_chunks.file_path, knowledge_chunks.ordinal
          LIMIT ?
        `).all(ftsQuery, normalizeLimit(input.limit)) as SqlRow[];
        return {
          ok: true,
          query,
          indexedAt: snapshot.indexedAt,
          matches: rows.map(searchMatch)
        };
      } finally {
        database.close();
      }
    });
  }

  uploadMarkdown(input: KnowledgeUploadInput) {
    return this.lock(async () => {
      const relativePath = validateDocumentPath(input.path, true);
      const content = typeof input.content === "string" ? input.content : "";
      if (!content.trim()) {
        throw new ServiceError(400, "KNOWLEDGE_CONTENT_EMPTY", "Markdown 内容不能为空。", "content");
      }
      if (hasLoneSurrogate(content)) {
        throw new ServiceError(400, "KNOWLEDGE_CONTENT_INVALID", "Markdown 内容包含无效字符。", "content");
      }
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new ServiceError(413, "KNOWLEDGE_FILE_TOO_LARGE", "Markdown 文件不能超过 8 MiB。", "content");
      }

      const root = await this.ensureSourceRoot();
      const segments = relativePath.split("/");
      const parent = await ensureDirectoryChain(root, segments.slice(0, -1));
      const target = path.join(parent, segments.at(-1)!);
      await assertMissingTarget(target);
      await publishFileWithoutOverwrite(parent, target, bytes);
      const snapshot = await this.syncUnlocked();
      return {
        ok: true,
        document: snapshot.documents.find((document) => document.path === relativePath),
        snapshot
      };
    });
  }

  deleteDocument(inputPath: unknown) {
    return this.lock(async () => {
      const relativePath = validateDocumentPath(inputPath, false);
      const root = await this.ensureSourceRoot();
      const target = path.resolve(root, ...relativePath.split("/"));
      assertInside(root, target);
      const stats = await safeLstat(target);
      if (!stats) throw new ServiceError(404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "知识库文件不存在。");
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new ServiceError(400, "KNOWLEDGE_DOCUMENT_INVALID", "知识库文件不可删除。");
      }
      await assertSafeParentChain(root, relativePath.split("/").slice(0, -1));
      await fs.unlink(target);
      return { ok: true, snapshot: await this.syncUnlocked() };
    });
  }

  private async syncUnlocked(options: { force?: boolean } = {}): Promise<KnowledgeSnapshot> {
    const root = await this.ensureSourceRoot();
    const sourceFiles = await scanSourceFiles(root);
    const database = await this.openIndex();
    try {
      const force = options.force || metadata(database, "parser-revision") !== PARSER_REVISION;
      const stored = new Map((database.prepare(`
        SELECT path, size_bytes, mtime_ns, ctime_ns FROM knowledge_files
      `).all() as SqlRow[]).map((row) => [String(row.path), row]));
      const changed = sourceFiles.filter((file) => force || fileChanged(file, stored.get(file.path)));
      const parsed: ParsedSourceFile[] = [];
      for (const file of changed) parsed.push(await parseSourceFile(file));
      const presentPaths = new Set(sourceFiles.map((file) => file.path));
      const indexedAt = this.now().toISOString();

      transaction(database, () => {
        for (const file of parsed) replaceIndexedFile(database, file, indexedAt);
        for (const storedPath of stored.keys()) {
          if (!presentPaths.has(storedPath)) {
            database.prepare("DELETE FROM knowledge_files WHERE path = ?").run(storedPath);
          }
        }
        setMetadata(database, "schema-version", INDEX_SCHEMA_VERSION);
        setMetadata(database, "parser-revision", PARSER_REVISION);
        setMetadata(database, "indexed-at", indexedAt);
      });
      const snapshot = readSnapshot(database, indexedAt);
      await writeDirectoryIndex(root, snapshot);
      return snapshot;
    } finally {
      database.close();
    }
  }

  private async ensureSourceRoot() {
    await fs.mkdir(this.sourceRoot, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(this.sourceRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ServiceError(500, "KNOWLEDGE_ROOT_INVALID", "知识库目录不可用。");
    }
    return await fs.realpath(this.sourceRoot);
  }

  private async openIndex() {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.indexPath);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    migrateIndex(database);
    return database;
  }

  private lock<T>(operation: () => Promise<T>) {
    return withKnowledgeLock(this.indexPath, operation);
  }
}

async function writeDirectoryIndex(root: string, snapshot: KnowledgeSnapshot) {
  const content: KnowledgeDirectoryIndex = { schemaVersion: 1, ...snapshot };
  const filePath = path.join(root, KNOWLEDGE_DIRECTORY_INDEX_FILE);
  const [parentStats, targetStats] = await Promise.all([
    fs.lstat(root, { bigint: true }),
    safeLstatBigInt(filePath)
  ]);
  if (
    !parentStats.isDirectory()
    || parentStats.isSymbolicLink()
    || (targetStats && (
      !targetStats.isFile()
      || targetStats.isSymbolicLink()
      || targetStats.nlink !== 1n
    ))
  ) {
    throw new ServiceError(500, "KNOWLEDGE_INDEX_FILE_INVALID", "知识库目录索引不可用。");
  }
  const bytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`, "utf8");
  const temporaryPath = path.join(
    root,
    `.${KNOWLEDGE_DIRECTORY_INDEX_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const [currentParent, currentTarget] = await Promise.all([
      fs.lstat(root, { bigint: true }),
      safeLstatBigInt(filePath)
    ]);
    if (
      !currentParent.isDirectory()
      || currentParent.isSymbolicLink()
      || currentParent.dev !== parentStats.dev
      || currentParent.ino !== parentStats.ino
      || !sameOptionalFileIdentity(targetStats, currentTarget)
    ) {
      throw new ServiceError(500, "KNOWLEDGE_INDEX_FILE_INVALID", "知识库目录索引不可用。");
    }
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(root);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function sameOptionalFileIdentity(
  left: Awaited<ReturnType<typeof safeLstatBigInt>>,
  right: Awaited<ReturnType<typeof safeLstatBigInt>>
) {
  if (!left || !right) return left === right;
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.nlink === 1n
    && right.nlink === 1n
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function knowledgeBaseForConfig(config: Pick<AppConfig, "persona">) {
  const agentId = config.persona.defaultAgentId;
  if (!AGENT_ID_PATTERN.test(agentId)) throw new Error(`Invalid knowledge base Agent ID: ${agentId}`);
  const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!agentWorkspace) throw new Error(`Invalid knowledge base workspace: ${config.persona.agentWorkspace}`);
  return new KnowledgeBaseService({
    sourceRoot: path.join(agentWorkspace, AGENT_RESOURCE_LAYOUT.knowledge),
    indexPath: getWorkspacePath(WORKSPACE_LAYOUT.knowledgeCache, `${agentId}.sqlite`)
  });
}

export function searchKnowledge(config: Pick<AppConfig, "persona">, input: KnowledgeSearchInput = {}) {
  return knowledgeBaseForConfig(config).search(input);
}

function migrateIndex(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS knowledge_files (
      path TEXT PRIMARY KEY,
      format TEXT NOT NULL CHECK (format IN ('jsonl', 'markdown', 'text')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      mtime_ns TEXT NOT NULL,
      ctime_ns TEXT NOT NULL,
      sha256 TEXT,
      chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
      status TEXT NOT NULL CHECK (status IN ('indexed', 'error')),
      error_code TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES knowledge_files(path) ON UPDATE CASCADE ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      path_tokens TEXT NOT NULL,
      body_tokens TEXT NOT NULL,
      content TEXT NOT NULL,
      UNIQUE(file_path, ordinal)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS knowledge_chunks_file ON knowledge_chunks(file_path, ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      path_tokens,
      body_tokens,
      content='knowledge_chunks',
      content_rowid='id',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
      INSERT INTO knowledge_chunks_fts(rowid, path_tokens, body_tokens)
      VALUES (new.id, new.path_tokens, new.body_tokens);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
      INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, path_tokens, body_tokens)
      VALUES ('delete', old.id, old.path_tokens, old.body_tokens);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
      INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, path_tokens, body_tokens)
      VALUES ('delete', old.id, old.path_tokens, old.body_tokens);
      INSERT INTO knowledge_chunks_fts(rowid, path_tokens, body_tokens)
      VALUES (new.id, new.path_tokens, new.body_tokens);
    END;
  `);
  const version = metadata(database, "schema-version");
  if (version && version !== INDEX_SCHEMA_VERSION) {
    throw new ServiceError(500, "KNOWLEDGE_INDEX_VERSION_UNSUPPORTED", "知识库索引版本不受支持。");
  }
}

async function scanSourceFiles(root: string) {
  const files: SourceFile[] = [];
  await walk(root, "", 0, files);
  return files.sort((left, right) => compareCodePoint(left.path, right.path));
}

async function walk(directory: string, relativeDirectory: string, depth: number, files: SourceFile[]) {
  if (depth > MAX_DEPTH) throw new ServiceError(413, "KNOWLEDGE_DEPTH_LIMIT", "知识库目录层级不能超过 32 层。");
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareCodePoint(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const stats = await fs.lstat(absolutePath, { bigint: true }) as BigIntStats;
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await walk(absolutePath, relativePath, depth + 1, files);
      continue;
    }
    const format = stats.isFile() ? knowledgeFormat(relativePath) : undefined;
    if (!format) continue;
    if (files.length >= MAX_FILES) {
      throw new ServiceError(413, "KNOWLEDGE_FILE_LIMIT", "单个 Agent 最多扫描 10000 个知识库文件。");
    }
    files.push({ path: relativePath, absolutePath, format, stats });
  }
}

async function parseSourceFile(file: SourceFile): Promise<ParsedSourceFile> {
  try {
    if (file.stats.nlink !== 1n) throw knowledgeFileError("KNOWLEDGE_FILE_LINKED");
    if (file.stats.size > BigInt(MAX_FILE_BYTES)) throw knowledgeFileError("KNOWLEDGE_FILE_TOO_LARGE");
    const bytes = await readBoundedFile(file);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw knowledgeFileError("KNOWLEDGE_FILE_INVALID_UTF8");
    }
    return { ...file, sha256, chunks: chunkKnowledgeDocument(content, file.format), status: "indexed" };
  } catch (error) {
    return {
      ...file,
      chunks: [],
      status: "error",
      errorCode: knowledgeErrorCode(error)
    };
  }
}

async function readBoundedFile(file: SourceFile) {
  const handle = await fs.open(file.absolutePath, fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true }) as BigIntStats;
    if (!sameFileIdentity(file.stats, before) || !before.isFile() || before.nlink !== 1n) {
      throw knowledgeFileError("KNOWLEDGE_FILE_CHANGED");
    }
    if (before.size > BigInt(MAX_FILE_BYTES)) throw knowledgeFileError("KNOWLEDGE_FILE_TOO_LARGE");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES || BigInt(offset) !== before.size) throw knowledgeFileError("KNOWLEDGE_FILE_CHANGED");
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    if (!sameFileIdentity(before, after)) throw knowledgeFileError("KNOWLEDGE_FILE_CHANGED");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function replaceIndexedFile(database: DatabaseSync, file: ParsedSourceFile, indexedAt: string) {
  database.prepare("DELETE FROM knowledge_files WHERE path = ?").run(file.path);
  database.prepare(`
    INSERT INTO knowledge_files (
      path, format, size_bytes, mtime_ns, ctime_ns, sha256,
      chunk_count, status, error_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file.path,
    file.format,
    Number(file.stats.size),
    file.stats.mtimeNs.toString(),
    file.stats.ctimeNs.toString(),
    file.sha256 ?? null,
    file.chunks.length,
    file.status,
    file.errorCode ?? null,
    indexedAt
  );
  if (file.status !== "indexed") return;
  const insert = database.prepare(`
    INSERT INTO knowledge_chunks (
      file_path, ordinal, start_line, end_line, path_tokens, body_tokens, content
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const pathTokens = tokenizeKnowledgeText(file.path).join(" ");
  for (const chunk of file.chunks) {
    insert.run(
      file.path,
      chunk.ordinal,
      chunk.startLine,
      chunk.endLine,
      pathTokens,
      tokenizeKnowledgeText(chunk.content).join(" "),
      chunk.content
    );
  }
}

function readSnapshot(database: DatabaseSync, fallbackIndexedAt: string): KnowledgeSnapshot {
  const documents = (database.prepare(`
    SELECT path, format, size_bytes, chunk_count, status, error_code, updated_at
    FROM knowledge_files ORDER BY path
  `).all() as SqlRow[]).map(documentRow);
  return {
    ok: true,
    root: "knowledge",
    documents,
    fileCount: documents.length,
    chunkCount: documents.reduce((sum, document) => sum + document.chunkCount, 0),
    errorCount: documents.filter((document) => document.status === "error").length,
    indexedAt: metadata(database, "indexed-at") ?? fallbackIndexedAt
  };
}

function documentRow(row: SqlRow): KnowledgeDocument {
  return {
    path: String(row.path),
    format: String(row.format) as KnowledgeDocumentFormat,
    sizeBytes: Number(row.size_bytes),
    chunkCount: Number(row.chunk_count),
    status: String(row.status) as "indexed" | "error",
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    updatedAt: String(row.updated_at)
  };
}

function searchMatch(row: SqlRow): KnowledgeSearchMatch {
  const rawContent = String(row.content);
  const truncated = rawContent.length > MAX_RESULT_CONTENT_CHARS;
  return {
    path: String(row.file_path),
    format: String(row.format) as KnowledgeDocumentFormat,
    ordinal: Number(row.ordinal),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    content: truncated ? `${rawContent.slice(0, MAX_RESULT_CONTENT_CHARS)}…` : rawContent,
    score: Number(Math.max(0, -Number(row.rank)).toFixed(6)),
    ...(truncated ? { truncated: true } : {})
  };
}

function fileChanged(file: SourceFile, stored: SqlRow | undefined) {
  return !stored
    || Number(stored.size_bytes) !== Number(file.stats.size)
    || String(stored.mtime_ns) !== file.stats.mtimeNs.toString()
    || String(stored.ctime_ns) !== file.stats.ctimeNs.toString();
}

function knowledgeFormat(filePath: string): KnowledgeDocumentFormat | undefined {
  const extension = path.posix.extname(filePath).toLocaleLowerCase();
  if (extension === ".jsonl") return "jsonl";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".txt") return "text";
  return undefined;
}

function validateDocumentPath(value: unknown, markdownOnly: boolean) {
  const input = typeof value === "string" ? value : "";
  if (!input || input.length > 512 || input.includes("\\") || input.startsWith("/") || input.normalize("NFC") !== input) {
    throw new ServiceError(400, "KNOWLEDGE_PATH_INVALID", "请输入有效的知识库相对路径。", "path");
  }
  const segments = input.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(segment))) {
    throw new ServiceError(400, "KNOWLEDGE_PATH_INVALID", "请输入有效的知识库相对路径。", "path");
  }
  const format = knowledgeFormat(input);
  if (!format || (markdownOnly && format !== "markdown")) {
    throw new ServiceError(
      400,
      "KNOWLEDGE_FORMAT_UNSUPPORTED",
      markdownOnly ? "只能上传 Markdown 文件。" : "该知识库文件类型不受支持。",
      "path"
    );
  }
  return segments.join("/");
}

async function ensureDirectoryChain(root: string, segments: string[]) {
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stats = await safeLstat(cursor);
    if (!stats) {
      try {
        await fs.mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stats = await fs.lstat(cursor);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ServiceError(400, "KNOWLEDGE_PATH_UNSAFE", "知识库路径包含不可用目录。", "path");
    }
  }
  return cursor;
}

async function assertSafeParentChain(root: string, segments: string[]) {
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stats = await fs.lstat(cursor);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ServiceError(400, "KNOWLEDGE_PATH_UNSAFE", "知识库路径包含不可用目录。", "path");
    }
  }
}

async function publishFileWithoutOverwrite(parent: string, target: string, bytes: Buffer) {
  const temporary = path.join(parent, `.knowledge-upload-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  let linked = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await fs.link(temporary, target);
    linked = true;
    await syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ServiceError(409, "KNOWLEDGE_DOCUMENT_EXISTS", "同路径文件已经存在。", "path");
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    if (linked) await syncDirectory(parent);
  }
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, fsConstants.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertMissingTarget(target: string) {
  const stats = await safeLstat(target);
  if (stats) throw new ServiceError(409, "KNOWLEDGE_DOCUMENT_EXISTS", "同路径文件已经存在。", "path");
}

async function safeLstat(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function safeLstatBigInt(target: string) {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizeQuery(value: unknown) {
  return typeof value === "string" ? value.normalize("NFKC").trim().slice(0, 1_000) : "";
}

function normalizeLimit(value: unknown) {
  const parsed = Number(value ?? 8);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 20) : 8;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function compareCodePoint(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertInside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ServiceError(400, "KNOWLEDGE_PATH_INVALID", "请输入有效的知识库相对路径。", "path");
  }
}

function knowledgeFileError(code: string) {
  return Object.assign(new Error(code), { code });
}

function knowledgeErrorCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && code.startsWith("KNOWLEDGE_") ? code : "KNOWLEDGE_FILE_READ_FAILED";
}

function hasLoneSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function transaction<T>(database: DatabaseSync, operation: () => T) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function metadata(database: DatabaseSync, key: string) {
  const row = database.prepare("SELECT value FROM knowledge_metadata WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? String(row.value) : undefined;
}

function setMetadata(database: DatabaseSync, key: string, value: string) {
  database.prepare(`
    INSERT INTO knowledge_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

async function withKnowledgeLock<T>(key: string, operation: () => Promise<T>) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}
