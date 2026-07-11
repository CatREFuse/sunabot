export type AttachmentSource = "message" | "quote" | "group_upload";

export interface IncomingAttachment {
  id: string;
  source: AttachmentSource;
  name: string;
  fileId?: string;
  sizeBytes?: number;
  url?: string;
  busId?: number;
  groupId?: number;
  userId?: number;
}

export type AttachmentStatus =
  | "pending"
  | "ready"
  | "partial"
  | "unsupported"
  | "too_large"
  | "failed";

export interface ParsedAttachment extends IncomingAttachment {
  status: AttachmentStatus;
  mimeType?: string;
  format?: string;
  sha256?: string;
  cacheKey?: string;
  textPreview?: string;
  chunkIndexPath?: string;
  visualPagePaths?: string[];
  visualSourcePath?: string;
  pageCount?: number;
  textCharacterCount?: number;
  truncated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface AttachmentModelContext {
  text: string;
  localImagePaths: string[];
  attachments: ParsedAttachment[];
}

export interface AttachmentExtractionContext {
  source?: AttachmentSource;
  messageId?: string | number;
  groupId?: number;
  userId?: number;
}
