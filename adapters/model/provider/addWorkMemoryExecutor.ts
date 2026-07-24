import { appendRequestLog } from "../../observability/requestLog.js";
import {
  ADD_WORKMEMORY_TOOL_NAME,
  runAddWorkMemory
} from "../../../services/tools/public.js";
import type { ProviderCompleteOptions, ResponseFunctionCallItem } from "./contracts.js";
import { logContextMetadata } from "./logger.js";

export async function executeAddWorkMemoryTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  const result = options.workingMemory
    ? await runAddWorkMemory(args, options.workingMemory, options.signal)
    : { ok: false, code: "ADD_WORKMEMORY_UNAVAILABLE", error: "Working-memory update is unavailable." };
  await appendRequestLog({
    category: "tool.call",
    action: ADD_WORKMEMORY_TOOL_NAME,
    request: { callId: call.call_id, arguments: args },
    response: result,
    metadata: logContextMetadata(options.logContext)
  });
  return result;
}
