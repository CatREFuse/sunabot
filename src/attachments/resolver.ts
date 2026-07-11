import path from "node:path";

export interface FileActionGateway {
  sendAction(action: string, params: Record<string, unknown>): Promise<unknown>;
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
  | {
      kind: "url";
      url: string;
    }
  | {
      kind: "base64";
      base64: string;
    }
  | {
      kind: "shared_path";
      filePath: string;
    };

export type ResolvedAttachmentSource =
  | (Extract<ExtractedAttachmentSource, { kind: "url" }> & {
      via: "message" | "get_group_file_url" | "get_private_file_url" | "get_file";
    })
  | (Extract<ExtractedAttachmentSource, { kind: "base64" }> & {
      via: "get_file";
    })
  | (Extract<ExtractedAttachmentSource, { kind: "shared_path" }> & {
      via: "get_file";
    });

export interface ResolutionAttempt {
  action: "get_group_file_url" | "get_private_file_url" | "get_file";
  outcome: "error" | "empty";
}

export class AttachmentResolutionError extends Error {
  readonly code = "attachment_unavailable";

  constructor(readonly attempts: ResolutionAttempt[]) {
    super("No usable attachment download source was returned by NapCat.");
    this.name = "AttachmentResolutionError";
  }
}

export async function resolveAttachmentSource(
  input: AttachmentResolutionInput,
  gateway: FileActionGateway,
  options: AttachmentResolverOptions = {}
): Promise<ResolvedAttachmentSource> {
  const directUrl = httpUrl(input.url);
  if (directUrl) {
    return { kind: "url", url: directUrl, via: "message" };
  }

  const attempts: ResolutionAttempt[] = [];
  const fileId = nonEmptyString(input.fileId);
  if (fileId && input.groupId != null) {
    const params: Record<string, unknown> = {
      group_id: input.groupId,
      file_id: fileId
    };
    if (input.busId != null) params.busid = input.busId;
    const source = await tryAction(
      gateway,
      "get_group_file_url",
      params,
      options,
      attempts
    );
    if (source?.kind === "url") {
      return { ...source, via: "get_group_file_url" };
    }
  } else if (fileId) {
    const source = await tryAction(
      gateway,
      "get_private_file_url",
      { file_id: fileId },
      options,
      attempts
    );
    if (source?.kind === "url") {
      return { ...source, via: "get_private_file_url" };
    }
  }

  const file = nonEmptyString(input.file);
  if (fileId || file) {
    const params = fileId ? { file_id: fileId } : { file: file! };
    const source = await tryAction(gateway, "get_file", params, options, attempts);
    if (source) return { ...source, via: "get_file" } as ResolvedAttachmentSource;
  }

  throw new AttachmentResolutionError(attempts);
}

export async function resolveAttachmentGetFileFallback(
  input: Pick<AttachmentResolutionInput, "fileId" | "file">,
  gateway: FileActionGateway,
  options: AttachmentResolverOptions = {}
): Promise<ResolvedAttachmentSource | undefined> {
  const fileId = nonEmptyString(input.fileId);
  const file = nonEmptyString(input.file);
  if (!fileId && !file) return undefined;
  try {
    const payload = await gateway.sendAction("get_file", fileId
      ? { file_id: fileId }
      : { file: file! });
    const source = extractAttachmentSource(payload, options);
    return source ? { ...source, via: "get_file" } as ResolvedAttachmentSource : undefined;
  } catch {
    return undefined;
  }
}

export function extractAttachmentSource(
  payload: unknown,
  options: AttachmentResolverOptions = {}
): ExtractedAttachmentSource | undefined {
  const root = record(payload);
  const data = root.data;
  const candidates = [data, root];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const source = sourceFromString(candidate, "value", options);
      if (source) return source;
      continue;
    }
    const value = record(candidate);
    if (!Object.keys(value).length) continue;

    for (const key of ["url", "download_url", "file_url"]) {
      const source = sourceFromString(value[key], key, options);
      if (source?.kind === "url") return source;
      if (source?.kind === "base64") return source;
    }
    for (const key of ["base64", "file_base64"]) {
      const source = sourceFromString(value[key], key, options);
      if (source?.kind === "base64") return source;
    }
    for (const key of ["file", "path", "file_path"]) {
      const source = sourceFromString(value[key], key, options);
      if (source) return source;
    }
  }
  return undefined;
}

async function tryAction(
  gateway: FileActionGateway,
  action: ResolutionAttempt["action"],
  params: Record<string, unknown>,
  options: AttachmentResolverOptions,
  attempts: ResolutionAttempt[]
) {
  try {
    const payload = await gateway.sendAction(action, params);
    const source = extractAttachmentSource(payload, options);
    if (source) return source;
    attempts.push({ action, outcome: "empty" });
  } catch {
    attempts.push({ action, outcome: "error" });
  }
  return undefined;
}

function sourceFromString(
  value: unknown,
  field: string,
  options: AttachmentResolverOptions
): ExtractedAttachmentSource | undefined {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const url = httpUrl(text);
  if (url) return { kind: "url", url };

  if (/^data:[^,]*;base64,/i.test(text)) {
    return { kind: "base64", base64: text };
  }
  if (/^base64:\/\//i.test(text)) {
    return { kind: "base64", base64: text.slice("base64://".length) };
  }
  if (field === "base64" || field === "file_base64") {
    return { kind: "base64", base64: text };
  }

  if (path.isAbsolute(text) && isAllowedSharedPath(text, options.sharedRoots ?? [])) {
    return { kind: "shared_path", filePath: path.resolve(text) };
  }
  return undefined;
}

function isAllowedSharedPath(candidate: string, roots: string[]) {
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function httpUrl(value: unknown) {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
