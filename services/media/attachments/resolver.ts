import type {
  AttachmentResolutionInput,
  AttachmentResolverOptions,
  AttachmentSourcePort,
  ResolvedAttachmentSource
} from "../../../packages/contracts/media/media.js";

export type {
  AttachmentResolutionInput,
  AttachmentResolverOptions,
  AttachmentSourcePort,
  ResolvedAttachmentSource
} from "../../../packages/contracts/media/media.js";
export { AttachmentResolutionError } from "../../../packages/contracts/media/media.js";

export async function resolveAttachmentSource(
  input: AttachmentResolutionInput,
  port: AttachmentSourcePort,
  options: AttachmentResolverOptions = {}
): Promise<ResolvedAttachmentSource> {
  const directUrl = httpUrl(input.url);
  if (directUrl) return { kind: "url", url: directUrl, via: "message_url" };
  return port.resolveAttachment(input, options);
}

export function resolveAttachmentFallback(
  input: Pick<AttachmentResolutionInput, "accountId" | "fileId" | "file">,
  port: AttachmentSourcePort,
  options: AttachmentResolverOptions = {}
) {
  return port.resolveAttachmentFallback(input, options);
}

function httpUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}
