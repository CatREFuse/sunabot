export type KnowledgeDocumentFormat = "jsonl" | "markdown" | "text";

export interface KnowledgeChunk {
  ordinal: number;
  startLine: number;
  endLine: number;
  content: string;
}

export interface KnowledgeDocument {
  path: string;
  format: KnowledgeDocumentFormat;
  sizeBytes: number;
  chunkCount: number;
  status: "indexed" | "error";
  errorCode?: string;
  updatedAt: string;
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

export interface KnowledgeSearchInput {
  query?: string | null;
  limit?: number | null;
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
}

export interface KnowledgeSearchResult {
  ok: boolean;
  query: string;
  matches: KnowledgeSearchMatch[];
  indexedAt?: string;
  error?: string;
}

export interface KnowledgeUploadInput {
  path?: string;
  content?: string;
}
