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

export interface AttachmentResolutionInput {
  fileId?: string;
  file?: string;
  url?: string;
  busId?: number;
  groupId?: number;
}

export interface AttachmentResolverOptions {
  sharedRoots?: string[];
}

export type ExtractedAttachmentSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; base64: string }
  | { kind: "shared_path"; filePath: string };

export type AttachmentResolutionStrategy = "group_file_url" | "private_file_url" | "file_content";

export type ResolvedAttachmentSource =
  | (Extract<ExtractedAttachmentSource, { kind: "url" }> & {
      via: "message_url" | AttachmentResolutionStrategy;
    })
  | (Extract<ExtractedAttachmentSource, { kind: "base64" | "shared_path" }> & {
      via: "file_content";
    });

export interface AttachmentResolutionAttempt {
  strategy: AttachmentResolutionStrategy;
  outcome: "error" | "empty";
}

export class AttachmentResolutionError extends Error {
  readonly code = "attachment_unavailable";

  constructor(readonly attempts: AttachmentResolutionAttempt[]) {
    super("No usable attachment source was returned by the messaging adapter.");
    this.name = "AttachmentResolutionError";
  }
}

export interface AttachmentSourcePort {
  resolveAttachment(
    input: AttachmentResolutionInput,
    options?: AttachmentResolverOptions
  ): Promise<ResolvedAttachmentSource>;
  resolveAttachmentFallback(
    input: Pick<AttachmentResolutionInput, "fileId" | "file">,
    options?: AttachmentResolverOptions
  ): Promise<ResolvedAttachmentSource | undefined>;
}

export type MediaAssetRefV1 =
  | {
      schemaVersion: 1;
      kind: "image";
      source: "remote_url" | "inline_data";
      url: string;
      altText?: string;
      filePath?: never;
    }
  | {
      schemaVersion: 1;
      kind: "image";
      source: "shared_file";
      filePath: string;
      url?: string;
      altText?: string;
    };

export interface ImageResult {
  url: string;
  filePath?: string;
  revisedPrompt?: string;
}

export function imageMediaAsset(url: string, altText?: string): MediaAssetRefV1 {
  return {
    schemaVersion: 1,
    kind: "image",
    source: /^data:image\//i.test(url) ? "inline_data" : "remote_url",
    url,
    ...(altText?.trim() ? { altText: altText.trim() } : {})
  };
}

export function generatedImageMediaAsset(image: Pick<ImageResult, "url" | "filePath">): MediaAssetRefV1 | undefined {
  if (image.filePath) {
    return {
      schemaVersion: 1,
      kind: "image",
      source: "shared_file",
      filePath: image.filePath,
      ...(image.url ? { url: image.url } : {})
    };
  }
  return image.url ? imageMediaAsset(image.url) : undefined;
}
