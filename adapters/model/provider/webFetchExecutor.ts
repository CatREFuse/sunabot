import { appendRequestLog } from "../../observability/requestLog.js";
import { defaultWebFetchService } from "../../webfetch/public.js";
import {
  WEBFETCH_TOOL_NAME,
  readWebFetchInput
} from "../../../services/tools/public.js";
import type {
  ProviderCompleteOptions,
  ResponseFunctionCallItem
} from "./contracts.js";
import { logContextMetadata } from "./logger.js";

export async function runWebFetch(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  const input = readWebFetchInput(args);
  if (!input) {
    const result = { ok: false, code: "INVALID_INPUT", error: "WebFetch 参数无效。" };
    await appendWebFetchLog(call, { argumentKeys: Object.keys(args).sort() }, result, options);
    return result;
  }
  const safeArguments = {
    url: input.url,
    semanticMatch: input.semanticMatch,
    ...(input.semanticMatch ? { queryLength: input.query.length } : {})
  };
  await appendWebFetchLog(call, safeArguments, { status: "running" }, options);
  const result = await defaultWebFetchService().fetch(input, { signal: options.signal });
  await appendWebFetchLog(call, safeArguments, webFetchLogResult(result), options);
  return result;
}

async function appendWebFetchLog(
  call: ResponseFunctionCallItem,
  args: Record<string, unknown>,
  response: unknown,
  options: ProviderCompleteOptions
) {
  await appendRequestLog({
    category: "tool.call",
    action: WEBFETCH_TOOL_NAME,
    request: { callId: call.call_id, arguments: args },
    response,
    metadata: logContextMetadata(options.logContext)
  });
}

function webFetchLogResult(result: unknown) {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return {
    ok: value.ok,
    code: value.code,
    finalUrl: value.finalUrl,
    fetchMode: value.fetchMode,
    semanticMatchApplied: value.semanticMatchApplied,
    contentLength: typeof value.content === "string" ? value.content.length : undefined,
    truncated: value.truncated,
    omittedBlockCount: value.omittedBlockCount
  };
}
