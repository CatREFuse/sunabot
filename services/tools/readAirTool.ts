export const READ_AIR_TOOL_NAME = "read_air";

export interface ReadAirToolInput {
  insight: string;
}

export interface ReadAirToolPort {
  execute(input: ReadAirToolInput, signal?: AbortSignal): Promise<unknown>;
}

export const readAirTool = {
  type: "function",
  name: READ_AIR_TOOL_NAME,
  description: [
    "Update the character's social field knowledge only when the conversation establishes a durable scoped convention.",
    "Use it for an explicitly confirmed nickname or form of address, local rule, boundary, correction, precondition, exception, default etiquette, or explained group-specific code word.",
    "Do not use it for public knowledge, public trends or memes, news, chat summaries, project progress, relationship mood, weather, meals, temporary plans, one-off behavior, or unsupported speculation.",
    "In insight, state the exact scope, confirmed convention, applicable preconditions or exceptions, evidence, and uncertainty. The host supplies the existing AIR.md and recent chat automatically."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      insight: {
        type: "string",
        minLength: 1,
        maxLength: 4_000,
        description: "The confirmed scoped convention, including its boundary, preconditions, exceptions, evidence, and uncertainty."
      }
    },
    required: ["insight"]
  },
  strict: true
} as const;

export async function runReadAir(input: unknown, port: ReadAirToolPort, signal?: AbortSignal) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "READ_AIR_INVALID", error: "read_air arguments must be an object." };
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "insight")) {
    return { ok: false, code: "READ_AIR_INVALID", error: "read_air contains unsupported arguments." };
  }
  if (typeof record.insight !== "string" || !record.insight.trim() || record.insight.length > 4_000) {
    return { ok: false, code: "READ_AIR_INVALID", error: "insight must contain 1 to 4000 characters." };
  }
  return port.execute({ insight: record.insight.trim() }, signal);
}
