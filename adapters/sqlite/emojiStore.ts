import type { DatabaseSync } from "node:sqlite";
import {
  isValidEmojiKey,
  normalizeEmojiKey
} from "../../services/emojis/emojiCatalog.js";

type SqlRow = Record<string, unknown>;

export interface EmojiRecord {
  key: string;
  fileName: string;
  source: "upload" | "generated";
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmojiVersionRecord extends EmojiRecord {
  current: boolean;
}

export class EmojiStore {
  constructor(private readonly database: DatabaseSync) {}

  readAll(): EmojiRecord[] {
    return (this.database.prepare(`
      SELECT emoji_key, file_name, source, size_bytes, width, height, created_at, updated_at
      FROM emojis ORDER BY updated_at DESC, emoji_key
    `).all() as SqlRow[]).flatMap((row) => {
      const record = mapEmojiRecord(row);
      return record ? [record] : [];
    });
  }

  read(key: string): EmojiRecord | undefined {
    if (!validStoredKey(key)) return undefined;
    const row = this.database.prepare(`
      SELECT emoji_key, file_name, source, size_bytes, width, height, created_at, updated_at
      FROM emojis WHERE emoji_key = ?
    `).get(key) as SqlRow | undefined;
    return row ? mapEmojiRecord(row) : undefined;
  }

  readVersions(key: string): EmojiVersionRecord[] {
    if (!validStoredKey(key)) return [];
    return (this.database.prepare(`
      SELECT
        versions.emoji_key,
        versions.file_name,
        versions.source,
        versions.size_bytes,
        versions.width,
        versions.height,
        emojis.created_at,
        versions.created_at AS updated_at,
        CASE WHEN versions.file_name = emojis.file_name THEN 1 ELSE 0 END AS is_current
      FROM emoji_versions AS versions
      JOIN emojis ON emojis.emoji_key = versions.emoji_key
      WHERE versions.emoji_key = ?
      ORDER BY is_current DESC, versions.created_at DESC, versions.file_name
    `).all(key) as SqlRow[]).flatMap((row) => {
      const record = mapEmojiRecord(row);
      return record ? [{ ...record, current: Number(row.is_current) === 1 }] : [];
    });
  }

  readVersion(key: string, fileName: string) {
    return this.readVersions(key).find((version) => version.fileName === fileName);
  }

  upsert(record: EmojiRecord) {
    if (!validStoredKey(record.key)) throw new Error("Emoji key is invalid.");
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO emojis (
          emoji_key, file_name, source, size_bytes, width, height, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(emoji_key) DO UPDATE SET
          file_name = excluded.file_name,
          source = excluded.source,
          size_bytes = excluded.size_bytes,
          width = excluded.width,
          height = excluded.height,
          updated_at = excluded.updated_at
      `).run(
        record.key,
        record.fileName,
        record.source,
        record.sizeBytes,
        record.width,
        record.height,
        record.createdAt,
        record.updatedAt
      );
      this.database.prepare(`
        INSERT INTO emoji_versions (
          emoji_key, file_name, source, size_bytes, width, height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(emoji_key, file_name) DO NOTHING
      `).run(
        record.key,
        record.fileName,
        record.source,
        record.sizeBytes,
        record.width,
        record.height,
        record.updatedAt
      );
    });
  }

  rename(currentKey: string, nextKey: string, updatedAt: string): "renamed" | "missing" | "conflict" {
    if (!validStoredKey(currentKey) || !validStoredKey(nextKey)) throw new Error("Emoji key is invalid.");
    return this.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM emojis WHERE emoji_key = ?").get(currentKey)) return "missing";
      if (currentKey !== nextKey && this.database.prepare("SELECT 1 FROM emojis WHERE emoji_key = ?").get(nextKey)) {
        return "conflict";
      }
      this.database.prepare("UPDATE emojis SET emoji_key = ?, updated_at = ? WHERE emoji_key = ?")
        .run(nextKey, updatedAt, currentKey);
      return "renamed";
    });
  }

  deleteVersion(key: string, fileName: string): "deleted" | "missing" | "current" {
    const version = this.readVersion(key, fileName);
    if (!version) return "missing";
    if (version.current) return "current";
    return Number(this.database.prepare(`
      DELETE FROM emoji_versions WHERE emoji_key = ? AND file_name = ?
    `).run(key, fileName).changes) > 0 ? "deleted" : "missing";
  }

  delete(key: string) {
    return Number(this.database.prepare("DELETE FROM emojis WHERE emoji_key = ?").run(key).changes) > 0;
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function validStoredKey(key: string) {
  return normalizeEmojiKey(key) === key && isValidEmojiKey(key);
}

function mapEmojiRecord(row: SqlRow): EmojiRecord | undefined {
  const key = String(row.emoji_key);
  if (!validStoredKey(key)) return undefined;
  return {
    key,
    fileName: String(row.file_name),
    source: String(row.source) as EmojiRecord["source"],
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
