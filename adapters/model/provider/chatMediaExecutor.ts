import { appendRequestLog } from "../../observability/requestLog.js";
import {
  EXPORT_CHAT_MEDIA_TOOL_NAME,
  IMPORT_CHAT_EMOJI_TOOL_NAME,
  readExportChatMediaInput,
  readImportChatEmojiInput
} from "../../../services/tools/public.js";
import type {
  ProviderCompleteOptions,
  ResponseFunctionCallItem
} from "./contracts.js";
import { logContextMetadata } from "./logger.js";

export async function runExportChatMedia(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.chatMedia) return { ok: false, error: "Chat media export is not available." };
  const input = readExportChatMediaInput(args);
  const result = await options.chatMedia.export(input);
  await appendChatMediaLog(EXPORT_CHAT_MEDIA_TOOL_NAME, call, { ...input }, result, options);
  return result;
}

export async function runImportChatEmoji(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.chatMedia?.importEmoji) {
    return { ok: false, error: "Chat emoji import is not available." };
  }
  const input = readImportChatEmojiInput(args);
  const result = await options.chatMedia.importEmoji(input);
  await appendChatMediaLog(IMPORT_CHAT_EMOJI_TOOL_NAME, call, { ...input }, result, options);
  return result;
}

async function appendChatMediaLog(
  action: string,
  call: ResponseFunctionCallItem,
  args: Record<string, unknown>,
  response: unknown,
  options: ProviderCompleteOptions
) {
  await appendRequestLog({
    category: "tool.call",
    action,
    request: {
      callId: call.call_id,
      arguments: args
    },
    response,
    metadata: logContextMetadata(options.logContext)
  });
}
