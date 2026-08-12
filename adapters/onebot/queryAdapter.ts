import path from "node:path";
import {
  AttachmentResolutionError,
  type AttachmentResolutionAttempt,
  type AttachmentResolutionInput,
  type AttachmentResolutionStrategy,
  type AttachmentResolverOptions,
  type ExtractedAttachmentSource,
  type ResolvedAttachmentSource
} from "../../packages/contracts/media/media.js";
import type { ConversationDirectorySnapshotV1 } from "../../packages/contracts/messaging/messages.js";

interface OneBotActionClient {
  sendAction(action: string, params: Record<string, unknown>, accountId?: string): Promise<unknown>;
}

export async function loadOneBotConversationDirectory(
  client: OneBotActionClient
): Promise<ConversationDirectorySnapshotV1> {
  const [friendsResult, groupsResult] = await Promise.allSettled([
    client.sendAction("get_friend_list", {}),
    client.sendAction("get_group_list", {})
  ]);
  const friends = friendsResult.status === "fulfilled"
    ? directoryPayload(friendsResult.value)
    : { ready: false, items: [] };
  const groups = groupsResult.status === "fulfilled"
    ? directoryPayload(groupsResult.value)
    : { ready: false, items: [] };
  return {
    friendsReady: friends.ready,
    groupsReady: groups.ready,
    friends: friends.items.flatMap((item) => {
      const userId = positiveInteger(item.user_id ?? item.userId);
      return userId ? [{
        userId,
        nickname: cleanText(item.nickname),
        remark: cleanText(item.remark)
      }] : [];
    }),
    groups: groups.items.flatMap((item) => {
      const groupId = positiveInteger(item.group_id ?? item.groupId);
      const groupName = cleanText(item.group_name ?? item.groupName);
      return groupId && groupName ? [{ groupId, groupName }] : [];
    })
  };
}

export async function resolveOneBotAttachment(
  client: OneBotActionClient,
  input: AttachmentResolutionInput,
  options: AttachmentResolverOptions = {}
): Promise<ResolvedAttachmentSource> {
  const attempts: AttachmentResolutionAttempt[] = [];
  const fileId = nonEmptyString(input.fileId);
  if (fileId && input.groupId != null) {
    const params: Record<string, unknown> = { group_id: input.groupId, file_id: fileId };
    if (input.busId != null) params.busid = input.busId;
    const source = await tryAction(
      client,
      "get_group_file_url",
      "group_file_url",
      params,
      input.accountId,
      options,
      attempts
    );
    if (source?.kind === "url") return { ...source, via: "group_file_url" };
  } else if (fileId) {
    const source = await tryAction(
      client,
      "get_private_file_url",
      "private_file_url",
      { file_id: fileId },
      input.accountId,
      options,
      attempts
    );
    if (source?.kind === "url") return { ...source, via: "private_file_url" };
  }

  const file = nonEmptyString(input.file);
  if (fileId || file) {
    const source = await tryAction(
      client,
      "get_file",
      "file_content",
      fileId ? { file_id: fileId } : { file: file! },
      input.accountId,
      options,
      attempts
    );
    if (source) return { ...source, via: "file_content" } as ResolvedAttachmentSource;
  }
  throw new AttachmentResolutionError(attempts);
}

export async function resolveOneBotAttachmentFallback(
  client: OneBotActionClient,
  input: Pick<AttachmentResolutionInput, "accountId" | "fileId" | "file">,
  options: AttachmentResolverOptions = {}
): Promise<ResolvedAttachmentSource | undefined> {
  const fileId = nonEmptyString(input.fileId);
  const file = nonEmptyString(input.file);
  if (!fileId && !file) return undefined;
  try {
    const payload = await client.sendAction(
      "get_file",
      fileId ? { file_id: fileId } : { file: file! },
      input.accountId
    );
    const source = extractOneBotAttachmentSource(payload, options);
    return source ? { ...source, via: "file_content" } as ResolvedAttachmentSource : undefined;
  } catch {
    return undefined;
  }
}

export function extractOneBotAttachmentSource(
  payload: unknown,
  options: AttachmentResolverOptions = {}
): ExtractedAttachmentSource | undefined {
  const root = record(payload);
  const candidates = [root.data, root];
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
      if (source?.kind === "url" || source?.kind === "base64") return source;
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
  client: OneBotActionClient,
  action: string,
  strategy: AttachmentResolutionStrategy,
  params: Record<string, unknown>,
  accountId: string | undefined,
  options: AttachmentResolverOptions,
  attempts: AttachmentResolutionAttempt[]
) {
  try {
    const source = extractOneBotAttachmentSource(
      await client.sendAction(action, params, accountId),
      options
    );
    if (source) return source;
    attempts.push({ strategy, outcome: "empty" });
  } catch {
    attempts.push({ strategy, outcome: "error" });
  }
  return undefined;
}

function directoryPayload(value: unknown) {
  const root = record(value);
  const status = cleanText(root.status).toLowerCase();
  const retcode = root.retcode == null ? 0 : Number(root.retcode);
  const ready = Array.isArray(root.data) && status !== "failed" && retcode === 0;
  return { ready, items: ready ? recordItems(root.data) : [] };
}

function sourceFromString(value: unknown, field: string, options: AttachmentResolverOptions): ExtractedAttachmentSource | undefined {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const url = httpUrl(text);
  if (url) return { kind: "url", url };
  if (/^data:[^,]*;base64,/i.test(text)) return { kind: "base64", base64: text };
  if (/^base64:\/\//i.test(text)) return { kind: "base64", base64: text.slice("base64://".length) };
  if (field === "base64" || field === "file_base64") return { kind: "base64", base64: text };
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
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

function recordItems(value: unknown) {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : 0;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}
