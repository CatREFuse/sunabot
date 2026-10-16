import { modelContentText } from "../../packages/contracts/model/modelContent.js";

export const ADD_USER_PROFILE_TOOL_NAME = "add_user_profile";
export const ADD_USER_PROFILE_MAX_CHARS = 4_000;
export const ADD_USER_PROFILE_MAX_ADDRESS_NAMES = 16;
export const ADD_USER_PROFILE_MAX_ADDRESS_NAME_CHARS = 64;
export const ADD_USER_PROFILE_STABLE_ERROR_CODES = [
  "ADD_USER_PROFILE_INVALID",
  "ADD_USER_PROFILE_UNAVAILABLE",
  "ADD_USER_PROFILE_FAILED",
  "ADD_USER_PROFILE_DECISION_DUPLICATE"
] as const;

const stableErrorCodes = new Set<string>(ADD_USER_PROFILE_STABLE_ERROR_CODES);

export function isAddUserProfileStableErrorCode(value: unknown): value is string {
  return typeof value === "string" && stableErrorCodes.has(value);
}

export interface AddUserProfileToolInput {
  action?: "record" | "skip";
  profile?: string;
  addressNames?: string[];
}

export interface AddUserProfileToolPort {
  execute(input: AddUserProfileToolInput, signal?: AbortSignal): Promise<unknown>;
  decisionRequired?: boolean;
  decisionResolved?(): boolean;
}

export const addUserProfileTool = {
  type: "function",
  name: ADD_USER_PROFILE_TOOL_NAME,
  description: [
    "Update the current speaker's profile when the conversation adds or corrects information useful in future conversations: identity, abilities, resources, preferences, habits, boundaries, long-term goals, or preferred forms of address.",
    "A clear statement such as 'call me Hoshino from now on', 'I prefer concise replies', or 'I use Windows' can support action=record on its first mention; the user does not need to ask you to remember it or name this tool. Compare with the supplied current-speaker profile and preserve still-valid facts while adding supported changes.",
    "When updating profile, provide the complete updated profile for the current speaker. When updating addressNames, provide the complete ordered list of still-valid forms of address, with the preferred form first. Omitted or null fields preserve their existing values; a name-only update does not require rewriting profile text.",
    "When this turn adds no supported profile change, use action=skip or omit the tool. This tool is independent of add_workmemory and read_air, with no required tool order. Working memory and AIR do not update the user profile.",
    "Do not store one-time events, temporary arrangements, current tasks, conversation summaries, guesses, sensitive inferences, or facts about another person.",
    "The host binds the current speaker's user ID, display name, Agent, and conversation source. Do not include identifiers or labeled schema fields in profile text."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: true,
    properties: {
      action: {
        type: "string",
        enum: ["record", "skip"],
        description: "record replaces the current speaker's aggregate profile; skip confirms that no profile update is needed."
      },
      profile: {
        type: ["string", "null"],
        description: "The complete updated aggregate profile. Omit or use null to preserve the existing profile."
      },
      addressNames: {
        type: ["array", "null"],
        items: {
          type: "string"
        },
        description: "The complete ordered forms of address. Omit or use null to preserve existing names."
      }
    },
    required: ["action"]
  },
  strict: false
} as const;

export async function runAddUserProfile(
  input: unknown,
  port: AddUserProfileToolPort,
  signal?: AbortSignal
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "ADD_USER_PROFILE_INVALID", error: "add_user_profile arguments must be an object." };
  }
  const record = input as Record<string, unknown>;
  const action = record.action;
  if (action !== "record" && action !== "skip") {
    return { ok: false, code: "ADD_USER_PROFILE_INVALID", error: "action must be record or skip." };
  }
  if (action === "skip") {
    return port.execute({ action: "skip" }, signal);
  }
  const addressNames = record.addressNames == null ? undefined : [...new Set(
    (Array.isArray(record.addressNames) ? record.addressNames : [record.addressNames])
      .map((value) => modelContentText(value).trim()).filter(Boolean)
  )];
  return port.execute({
    action: "record",
    ...(record.profile == null ? {} : { profile: modelContentText(record.profile).trim() }),
    ...(addressNames == null ? {} : { addressNames })
  }, signal);
}
