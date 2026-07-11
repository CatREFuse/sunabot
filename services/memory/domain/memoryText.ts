import type { SourceDefinition } from "../types.js";
import { normalizeText } from "./normalizers.js";

export function readMemoryText(source: SourceDefinition, value: Record<string, unknown>) {
  for (const field of source.fields) {
    const text = normalizeText(value[field]);
    if (text) return text;
  }
  return "";
}
