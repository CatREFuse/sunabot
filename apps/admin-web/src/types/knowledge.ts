import type { WorkbenchBackend } from "./workbench";

export type KnowledgeDocumentFormat = "jsonl" | "markdown" | "text";

export interface KnowledgeDocument {
  path: string;
  format: KnowledgeDocumentFormat;
  sizeBytes: number;
  chunkCount: number;
  status: "indexed" | "error";
  errorCode?: string;
  updatedAt: string;
  workbench?: WorkbenchBackend;
}

export interface KnowledgeSnapshot {
  ok: true;
  root: "knowledge";
  documents: KnowledgeDocument[];
  fileCount: number;
  chunkCount: number;
  errorCount: number;
  indexedAt: string;
}

export interface KnowledgeSearchMatch {
  path: string;
  format: KnowledgeDocumentFormat;
  ordinal: number;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  truncated?: boolean;
  workbench?: WorkbenchBackend;
}

export interface KnowledgeSearchResult {
  ok: boolean;
  query: string;
  matches: KnowledgeSearchMatch[];
  indexedAt?: string;
  error?: string;
}
