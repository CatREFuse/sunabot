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
    "Make exactly one user-profile decision for the current ordinary reply after the working-memory decision and before using other tools or returning visible text.",
    "Use action=record when the current speaker has provided stable information that should remain useful across conversations, including identity, abilities, resources, preferences, habits, boundaries, long-term goals, or preferred forms of address. Use action=skip when this turn adds no supported stable profile information.",
    "When recording, profile must be the complete updated profile for the current speaker, preserving every still-valid fact already present in the supplied user profile while adding, correcting, or removing only what the conversation supports.",
    "addressNames must be the complete ordered list of still-valid forms of address. Put the preferred form first and preserve the relative order of other still-valid names.",
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
        description: "The complete updated aggregate profile when action=record, or null when action=skip."
      },
      addressNames: {
        type: ["array", "null"],
        items: {
          type: "string"
        },
        description: "The complete ordered forms of address when action=record, or null when action=skip."
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
