export const CALL_DIRECTOR_TOOL_NAME = "call_director";

export interface CallDirectorToolInput {
  request: string;
}

export interface CallDirectorToolPort {
  execute(input: CallDirectorToolInput, signal?: AbortSignal): Promise<unknown>;
}

export const callDirectorTool = {
  type: "function",
  name: CALL_DIRECTOR_TOOL_NAME,
  description: [
    "Ask the character's performance director to revise the remaining schedule for today.",
    "Use this only when the character has a concrete in-world reason to change plans, such as a new idea, delay, invitation, unfinished duty, weather constraint, or a promise made in conversation.",
    "Describe the desired change and the in-world reason. The director keeps completed events and rejects changes that violate the character's seed script or current time."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      request: {
        type: "string",
        minLength: 1,
        maxLength: 4_000,
        description: "The requested schedule change and the character's in-world reason."
      }
    },
    required: ["request"]
  },
  strict: true
} as const;

export async function runCallDirector(
  input: unknown,
  port: CallDirectorToolPort,
  signal?: AbortSignal
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "CALL_DIRECTOR_INVALID", error: "call_director arguments must be an object." };
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "request")) {
    return { ok: false, code: "CALL_DIRECTOR_INVALID", error: "call_director contains unsupported arguments." };
  }
  if (typeof record.request !== "string" || !record.request.trim() || record.request.length > 4_000) {
    return { ok: false, code: "CALL_DIRECTOR_INVALID", error: "request must contain 1 to 4000 characters." };
  }
  return port.execute({ request: record.request.trim() }, signal);
}
