import { appendRequestLog } from "../../observability/requestLog.js";
import {
  ADD_WORKMEMORY_TOOL_NAME,
  runAddWorkMemory
} from "../../../services/tools/public.js";
import type { ProviderCompleteOptions, ResponseFunctionCallItem } from "./contracts.js";
import { logContextMetadata } from "./logger.js";
import {
  projectAddWorkMemoryArgumentsLog,
  projectAddWorkMemoryResultLog
} from "./requestLogProjection.js";
import { errorMessage } from "./valueUtils.js";

export async function executeAddWorkMemoryTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  let result: unknown;
  try {
    result = options.workingMemory
      ? await runAddWorkMemory(args, options.workingMemory, options.signal)
      : { ok: false, code: "ADD_WORKMEMORY_UNAVAILABLE", error: "Working-memory update is unavailable." };
  } catch (error) {
    result = {
      ok: false,
      code: "ADD_WORKMEMORY_FAILED",
      error: errorMessage(error)
    };
  }
  await appendRequestLog({
    category: "tool.call",
    action: ADD_WORKMEMORY_TOOL_NAME,
    request: {
      callId: call.call_id,
      ...projectAddWorkMemoryArgumentsLog(args)
    },
    response: projectAddWorkMemoryResultLog(result),
    metadata: logContextMetadata(options.logContext)
  });
  return result;
}
