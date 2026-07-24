import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig, ImageHistoryRecord } from "../../packages/contracts/admin/public.js";
import { getWorkspacePath } from "../../packages/platform/projectPaths.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";

type SqlRow = Record<string, unknown>;

export function generatedImageHistoryRecords(imageDir: string, agentId = "plana") {
  if (!fs.existsSync(imageDir)) return [];
  return fs.readdirSync(imageDir, { withFileTypes: true })
    .flatMap((entry): ImageHistoryRecord[] => {
      if (!entry.isFile() || entry.name.startsWith("emoji-") || !entry.name.endsWith(".png")) return [];
      const filePath = path.join(imageDir, entry.name);
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile()) return [];
      return [{
        id: entry.name,
        url: agentId === "plana"
          ? `/generated-images/${entry.name}`
          : `/generated-images/agents/${encodeURIComponent(agentId)}/${entry.name}`,
        filePath,
        createdAt: generatedImageCreatedAt(entry.name) ?? stats.mtime.toISOString()
      }];
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export class ImageHistoryStore {
  constructor(private readonly database: DatabaseSync) {}

  read() {
    return this.database.prepare(`
      SELECT data_json FROM image_history ORDER BY created_at DESC, id LIMIT 80
    `).all().map((row) => JSON.parse(String((row as SqlRow).data_json)) as ImageHistoryRecord);
  }

  replace(records: readonly ImageHistoryRecord[]) {
    this.transaction(() => this.replaceUnsafe(records));
  }

  append(record: ImageHistoryRecord) {
    this.transaction(() => {
      const records = [record, ...this.read()]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id || candidate.url === item.url) === index)
        .slice(0, 80);
      this.replaceUnsafe(records);
    });
  }

  ensureLegacyImported(filePath: string) {
    const marker = "legacy-image-history";
    if (this.metadata(marker) === "done") return { imported: false, count: this.count() };
    const records = readImageHistoryJson(filePath);
    this.transaction(() => {
      if (this.count() === 0) {
        const insert = this.database.prepare(`
          INSERT INTO image_history (id, url, created_at, data_json) VALUES (?, ?, ?, ?)
        `);
        for (const record of records) insert.run(record.id, record.url, record.createdAt, JSON.stringify(record));
      }
      this.setMetadata(marker, "done");
    });
    return { imported: records.length > 0, count: this.count() };
  }

  ensureGeneratedIndexed(config?: Pick<AppConfig, "persona">) {
    const marker = "generated-image-history-v1";
    if (this.metadata(marker) === "done") return { indexed: false, count: this.count() };
    const agentId = config?.persona.defaultAgentId.trim() || "plana";
    const imageDir = agentId === "plana"
      ? getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
      : getWorkspacePath(WORKSPACE_LAYOUT.mediaImages, "agents", agentId);
    const recovered = generatedImageHistoryRecords(imageDir, agentId);
    this.transaction(() => {
      if (this.metadata(marker) === "done") return;
      const records = [...this.read(), ...recovered]
        .filter((record, index, all) => all.findIndex((candidate) => candidate.id === record.id || candidate.url === record.url) === index)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 80);
      this.replaceUnsafe(records);
      this.setMetadata(marker, "done");
    });
    return { indexed: recovered.length > 0, count: this.count() };
  }

  count() {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM image_history").get() as SqlRow | undefined;
    return Number(row?.count ?? 0);
  }

  private replaceUnsafe(records: readonly ImageHistoryRecord[]) {
    this.database.prepare("DELETE FROM image_history").run();
    const insert = this.database.prepare(`
      INSERT INTO image_history (id, url, created_at, data_json) VALUES (?, ?, ?, ?)
    `);
    for (const record of records) insert.run(record.id, record.url, record.createdAt, JSON.stringify(record));
  }

  private metadata(key: string) {
    const row = this.database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as SqlRow | undefined;
    return row ? String(row.value) : undefined;
  }

  private setMetadata(key: string, value: string) {
    this.database.prepare(`
      INSERT INTO app_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private transaction<T>(operation: () => T): T {
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

function readImageHistoryJson(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`Invalid image history store at ${filePath}`);
  return parsed.filter((record): record is ImageHistoryRecord => Boolean(
    record && typeof record === "object" &&
    typeof (record as ImageHistoryRecord).id === "string" &&
    typeof (record as ImageHistoryRecord).url === "string" &&
    typeof (record as ImageHistoryRecord).createdAt === "string"
  ));
}

function generatedImageCreatedAt(fileName: string) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/);
  if (!match) return undefined;
  const value = `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}
