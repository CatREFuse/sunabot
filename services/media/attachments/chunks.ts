import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_TEXT_CHUNK_CHARACTERS = 8_000;
export const DEFAULT_TEXT_CHUNK_OVERLAP = 400;

export interface AttachmentTextChunk {
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  title?: string;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
}

export interface TextChunkerOptions {
  maxCharacters?: number;
  overlapCharacters?: number;
  minimumBoundaryRatio?: number;
  title?: (index: number) => string | undefined;
}

/**
 * Incrementally divides decoded text without retaining previously emitted chunks.
 * Character offsets use JavaScript string offsets and endChar is exclusive.
 */
export class StreamingTextChunker {
  private readonly maxCharacters: number;
  private readonly overlapCharacters: number;
  private readonly minimumBoundaryRatio: number;
  private readonly title?: (index: number) => string | undefined;
  private pending = "";
  private pendingStart = 0;
  private nextIndex = 0;
  private ended = false;

  constructor(options: TextChunkerOptions = {}) {
    this.maxCharacters = integerOption(
      options.maxCharacters,
      DEFAULT_TEXT_CHUNK_CHARACTERS,
      "maxCharacters",
      1
    );
    this.overlapCharacters = integerOption(
      options.overlapCharacters,
      DEFAULT_TEXT_CHUNK_OVERLAP,
      "overlapCharacters",
      0
    );
    if (this.overlapCharacters >= this.maxCharacters) {
      throw new RangeError("overlapCharacters must be smaller than maxCharacters");
    }

    const minimumBoundaryRatio = options.minimumBoundaryRatio ?? 0.5;
    if (!Number.isFinite(minimumBoundaryRatio) || minimumBoundaryRatio < 0 || minimumBoundaryRatio > 1) {
      throw new RangeError("minimumBoundaryRatio must be between 0 and 1");
    }
    this.minimumBoundaryRatio = minimumBoundaryRatio;
    this.title = options.title;
  }

  push(value: string): AttachmentTextChunk[] {
    if (this.ended) throw new Error("Text chunker has already ended");
    if (!value) return [];

    this.pending += value;
    const chunks: AttachmentTextChunk[] = [];
    while (this.pending.length > this.maxCharacters) {
      const splitAt = this.findSplitPosition();
      this.emitPrefix(splitAt, chunks);
    }
    return chunks;
  }

  end(value = ""): AttachmentTextChunk[] {
    if (this.ended) throw new Error("Text chunker has already ended");
    const chunks = this.push(value);
    this.ended = true;
    if (this.pending.length > 0) {
      this.appendChunk(this.pending, this.pendingStart, chunks);
      this.pendingStart += this.pending.length;
      this.pending = "";
    }
    return chunks;
  }

  private findSplitPosition() {
    const target = this.maxCharacters;
    const minimum = Math.floor(target * this.minimumBoundaryRatio);
    const prefix = this.pending.slice(0, target + 1);

    const paragraph = prefix.lastIndexOf("\n\n", target);
    if (paragraph >= minimum) return paragraph + 2;

    const newline = prefix.lastIndexOf("\n", target);
    if (newline >= minimum) return newline + 1;

    for (let index = target; index >= minimum; index -= 1) {
      if (/\s/u.test(prefix[index] ?? "")) return index + 1;
    }
    return target;
  }

  private emitPrefix(splitAt: number, chunks: AttachmentTextChunk[]) {
    const safeSplit = Math.max(1, Math.min(splitAt, this.maxCharacters));
    const text = this.pending.slice(0, safeSplit);
    this.appendChunk(text, this.pendingStart, chunks);

    const consumed = Math.max(1, safeSplit - this.overlapCharacters);
    this.pending = this.pending.slice(consumed);
    this.pendingStart += consumed;
  }

  private appendChunk(text: string, startChar: number, chunks: AttachmentTextChunk[]) {
    if (!text.trim()) return;
    const chunk: AttachmentTextChunk = {
      index: this.nextIndex,
      text,
      startChar,
      endChar: startChar + text.length
    };
    const title = this.title?.(this.nextIndex);
    if (title) chunk.title = title;
    chunks.push(chunk);
    this.nextIndex += 1;
  }
}

export function chunkText(text: string, options: TextChunkerOptions = {}) {
  const chunker = new StreamingTextChunker(options);
  return chunker.end(text);
}

export class SqliteChunkWriter {
  private committed = false;
  private aborted = false;

  private constructor(
    readonly outputPath: string,
    readonly temporaryPath: string,
    private readonly database: DatabaseSync
  ) {}

  static async open(outputPath: string) {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.${randomUUID()}.part`
    );
    const database = new DatabaseSync(temporaryPath, { timeout: 5_000 });
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    database.exec(`
      CREATE TABLE attachment_chunks (
        chunk_index INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      );
      CREATE INDEX attachment_chunks_text ON attachment_chunks(text);
      BEGIN IMMEDIATE;
    `);
    return new SqliteChunkWriter(outputPath, temporaryPath, database);
  }

  async write(chunk: AttachmentTextChunk) {
    this.assertWritable();
    this.database.prepare(`
      INSERT INTO attachment_chunks (chunk_index, text, data_json) VALUES (?, ?, ?)
    `).run(chunk.index, chunk.text, JSON.stringify(chunk));
  }

  async commit() {
    this.assertWritable();
    this.database.exec("COMMIT");
    this.database.close();
    await fsp.rm(this.outputPath, { force: true });
    await fsp.rename(this.temporaryPath, this.outputPath);
    this.committed = true;
  }

  async abort() {
    if (this.committed || this.aborted) return;
    this.aborted = true;
    if (this.database.isOpen) {
      try {
        this.database.exec("ROLLBACK");
      } finally {
        this.database.close();
      }
    }
    await fsp.rm(this.temporaryPath, { force: true });
  }

  private assertWritable() {
    if (this.committed) throw new Error("SQLite chunk writer has already committed");
    if (this.aborted) throw new Error("SQLite chunk writer has already aborted");
  }
}

export function readChunksSqlite(filePath: string) {
  const database = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
  try {
    return database.prepare(`
      SELECT data_json FROM attachment_chunks ORDER BY chunk_index
    `).all().map((row) => JSON.parse(String((row as Record<string, unknown>).data_json)) as AttachmentTextChunk);
  } finally {
    database.close();
  }
}

function integerOption(value: number | undefined, fallback: number, name: string, minimum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return resolved;
}
