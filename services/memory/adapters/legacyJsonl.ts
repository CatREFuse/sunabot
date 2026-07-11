import fs from "node:fs/promises";
import type { MemoryRecord } from "../types.js";
import { normalizeText } from "../domain/normalizers.js";

export async function readStrictJsonlFile(filePath: string) {
  const raw = await readOptional(filePath);
  return parseStrictJsonl(raw, filePath).map((record) => structuredClone(record.value));
}

export function parseStrictJsonl(raw: string, filePath: string) {
  const records: MemoryRecord[] = [];
  const ids = new Set<string>();
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid JSONL object at ${filePath}:${index + 1}`);
    }
    const record = value as Record<string, unknown>;
    const id = normalizeText(record.id);
    if (id && ids.has(id)) throw new Error(`Duplicate JSONL id ${id} at ${filePath}:${index + 1}`);
    if (id) ids.add(id);
    records.push({ index, value: record });
  }
  return records;
}

export async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
