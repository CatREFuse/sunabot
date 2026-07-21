import { appendRequestLog } from "../../../src/requestLog.js";
import { runReadAir } from "../../../services/tools/public.js";
import type { ProviderCompleteOptions, ResponseFunctionCallItem } from "./contracts.js";
import { logContextMetadata } from "./logger.js";

export { READ_AIR_TOOL_NAME } from "../../../services/tools/public.js";

export async function executeReadAirTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  const result = options.air
    ? await runReadAir(args, options.air, options.signal)
    : { ok: false, code: "READ_AIR_UNAVAILABLE", error: "Read-air is unavailable." };
  await appendRequestLog({
    category: "tool.call",
    action: "read_air",
    request: { callId: call.call_id, arguments: args },
    response: result,
    metadata: logContextMetadata(options.logContext)
  });
  return result;
}
