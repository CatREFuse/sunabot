import { appendRequestLog } from "../../observability/requestLog.js";
import {
  ADD_USER_PROFILE_TOOL_NAME,
  runAddUserProfile
} from "../../../services/tools/public.js";
import type { ProviderCompleteOptions, ResponseFunctionCallItem } from "./contracts.js";
import { logContextMetadata } from "./logger.js";
import {
  projectAddUserProfileArgumentsLog,
  projectAddUserProfileResultLog
} from "./requestLogProjection.js";
import { errorMessage } from "./valueUtils.js";

export async function executeAddUserProfileTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  let result: unknown;
  try {
    result = options.userProfile
      ? await runAddUserProfile(args, options.userProfile, options.signal)
      : { ok: false, code: "ADD_USER_PROFILE_UNAVAILABLE", error: "User-profile update is unavailable." };
  } catch (error) {
    result = {
      ok: false,
      code: "ADD_USER_PROFILE_FAILED",
      error: errorMessage(error)
    };
  }
  await appendRequestLog({
    category: "tool.call",
    action: ADD_USER_PROFILE_TOOL_NAME,
    request: {
      callId: call.call_id,
      ...projectAddUserProfileArgumentsLog(args)
    },
    response: projectAddUserProfileResultLog(result),
    metadata: logContextMetadata(options.logContext)
  });
  return result;
}
