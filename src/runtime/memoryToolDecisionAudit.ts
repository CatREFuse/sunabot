import type {
  AddUserProfileToolPort,
  AddWorkMemoryToolPort
} from "../../services/tools/public.js";
import type { SunaRuntime } from "../runtime.js";
import type { ParsedIncomingMessage } from "../types.js";
import { isolateReplyModule } from "./replyModuleIsolation.js";

type MemoryToolPorts = {
  workingMemory?: AddWorkMemoryToolPort;
  userProfile?: AddUserProfileToolPort;
};

export function createMemoryToolDecisionAuditor(
  host: SunaRuntime,
  incoming: ParsedIncomingMessage,
  signal?: AbortSignal
) {
  let workingMemoryAudited = false;
  let userProfileAudited = false;
  return async (toolNames: readonly string[], ports: MemoryToolPorts) => {
    if (
      !workingMemoryAudited
      && ports.workingMemory
      && ports.workingMemory.decisionResolved?.() !== true
    ) {
      workingMemoryAudited = true;
      await isolateReplyModule(
        "memory.tool_decision",
        async () => host.workingMemory.recordToolDecision(incoming, toolNames),
        () => undefined,
        { signal }
      );
    }
    if (
      !userProfileAudited
      && ports.userProfile
      && ports.userProfile.decisionResolved?.() !== true
    ) {
      userProfileAudited = true;
      await isolateReplyModule(
        "user_profile.tool_decision",
        async () => host.userProfile.recordToolDecision(incoming, toolNames),
        () => undefined,
        { signal }
      );
    }
  };
}
