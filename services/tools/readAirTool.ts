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
    "Update the character's social field knowledge after the conversation reveals durable context needed to read the room.",
    "Always use it for explicit preferences, dislikes, taboos, boundaries, requested nicknames, local rules, corrections, relationship changes, shared topics, or an explained group-specific meme, code word, implication, or running joke.",
    "Also use it when repeated chat evidence makes a local expression understandable. Do not use it for a transient factual question or unsupported speculation.",
    "In insight, state the character's interpretation, relevant scope, evidence, uncertainty, and what future conversations need to understand. The host supplies the existing AIR.md and recent chat automatically."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      insight: {
        type: "string",
        minLength: 1,
        maxLength: 4_000,
        description: "The character's scoped interpretation of what the social field now means and why it matters."
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
