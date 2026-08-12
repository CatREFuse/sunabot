import { readUserProfileForUser } from "../../services/memory/memoryService.js";
import type { AppConfig, ParsedIncomingMessage } from "../types.js";
import {
  buildUserProfileRecallQuery,
  buildWorkingMemoryRecallQuery,
  uniqueMemoryEntries
} from "./conversationMemoryHelpers.js";
import { ModelContextMemoryRecall } from "./memoryRecallExposure.js";
import { isolateReplyModule } from "./replyModuleIsolation.js";

export async function prepareReplyMemoryContext(
  config: AppConfig,
  logRunId: string,
  incoming: ParsedIncomingMessage,
  text: string,
  admin: Parameters<typeof buildUserProfileRecallQuery>[2],
  signal?: AbortSignal
) {
  const workingQuery = buildWorkingMemoryRecallQuery(incoming, text);
  const userProfileQuery = buildUserProfileRecallQuery(incoming, text, admin);
  const exactUserProfile = await isolateReplyModule(
    "memory.user_profile",
    () => readUserProfileForUser(config, String(incoming.userId)),
    () => null,
    { signal }
  );
  const modelContextMemory = new ModelContextMemoryRecall(config, logRunId);
  const [longTermResult, workingResult, userProfileResult] = await Promise.all([
    isolateReplyModule(
      "memory.long_term",
      () => modelContextMemory.search({ query: text, source: "long_term", limit: 8 }),
      () => unavailableRecall(text),
      { signal }
    ),
    isolateReplyModule(
      "memory.working",
      () => modelContextMemory.search({ query: workingQuery, source: "working", limit: 8 }),
      () => unavailableRecall(workingQuery),
      { signal }
    ),
    isolateReplyModule(
      "memory.user_profile_recall",
      () => modelContextMemory.search({ query: userProfileQuery, source: "user_profile", limit: 6 }),
      () => unavailableRecall(userProfileQuery),
      { signal }
    )
  ]);
  const longTermMemoryMatches = longTermResult.ok ? longTermResult.matches : [];
  const workingMemoryMatches = workingResult.ok ? workingResult.matches : [];
  const userProfileMemoryMatches = userProfileResult.ok ? userProfileResult.matches : [];
  const currentUserProfileMemoryMatches = uniqueMemoryEntries([
    ...(exactUserProfile ? [exactUserProfile] : []),
    ...userProfileMemoryMatches
  ]);
  return {
    modelContextMemory,
    longTermMemoryMatches,
    workingMemoryMatches,
    userProfileMemoryMatches,
    currentUserProfileMemoryMatches,
    memoryMatches: uniqueMemoryEntries([
      ...workingMemoryMatches,
      ...longTermMemoryMatches,
      ...currentUserProfileMemoryMatches
    ]),
    exactUserProfile: Boolean(exactUserProfile),
    queries: {
      longTerm: text,
      working: workingQuery,
      userProfile: userProfileQuery
    }
  };
}

function unavailableRecall(query: string) {
  return {
    ok: false,
    query,
    matches: [],
    error: "MEMORY_RECALL_UNAVAILABLE"
  };
}
