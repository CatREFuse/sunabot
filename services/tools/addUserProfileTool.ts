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
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["record", "skip"],
        description: "record replaces the current speaker's aggregate profile; skip confirms that no profile update is needed."
      },
      profile: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: ADD_USER_PROFILE_MAX_CHARS,
        description: "The complete updated aggregate profile when action=record, or null when action=skip."
      },
      addressNames: {
        type: ["array", "null"],
        items: {
          type: "string",
          minLength: 1,
          maxLength: ADD_USER_PROFILE_MAX_ADDRESS_NAME_CHARS
        },
        maxItems: ADD_USER_PROFILE_MAX_ADDRESS_NAMES,
        description: "The complete ordered forms of address when action=record, or null when action=skip."
      }
    },
    required: ["action", "profile", "addressNames"]
  },
  strict: true
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
  if (Object.keys(record).some((key) => key !== "action" && key !== "profile" && key !== "addressNames")) {
    return { ok: false, code: "ADD_USER_PROFILE_INVALID", error: "add_user_profile contains unsupported arguments." };
  }
  const action = record.action;
  if (action !== "record" && action !== "skip") {
    return { ok: false, code: "ADD_USER_PROFILE_INVALID", error: "action must be record or skip." };
  }
  if (action === "skip") {
    if (record.profile !== null || record.addressNames !== null) {
      return {
        ok: false,
        code: "ADD_USER_PROFILE_INVALID",
        error: "profile and addressNames must be null when action is skip."
      };
    }
    return port.execute({ action: "skip" }, signal);
  }
  if (
    typeof record.profile !== "string"
    || !record.profile.trim()
    || Array.from(record.profile).length > ADD_USER_PROFILE_MAX_CHARS
  ) {
    return {
      ok: false,
      code: "ADD_USER_PROFILE_INVALID",
      error: `profile must contain 1 to ${ADD_USER_PROFILE_MAX_CHARS} characters.`
    };
  }
  if (!Array.isArray(record.addressNames) || record.addressNames.length > ADD_USER_PROFILE_MAX_ADDRESS_NAMES) {
    return {
      ok: false,
      code: "ADD_USER_PROFILE_INVALID",
      error: `addressNames must contain at most ${ADD_USER_PROFILE_MAX_ADDRESS_NAMES} strings.`
    };
  }
  const addressNames: string[] = [];
  const seen = new Set<string>();
  for (const value of record.addressNames) {
    if (
      typeof value !== "string"
      || !value.trim()
      || Array.from(value).length > ADD_USER_PROFILE_MAX_ADDRESS_NAME_CHARS
    ) {
      return {
        ok: false,
        code: "ADD_USER_PROFILE_INVALID",
        error: `Each address name must contain 1 to ${ADD_USER_PROFILE_MAX_ADDRESS_NAME_CHARS} characters.`
      };
    }
    const normalized = value.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    addressNames.push(normalized);
  }
  return port.execute({
    action: "record",
    profile: record.profile.trim(),
    addressNames
  }, signal);
}
