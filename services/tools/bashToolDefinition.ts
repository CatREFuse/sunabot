import { WORKSPACE_BASH_EXECUTION_TIMEOUT_MS } from "./bashRuntime.js";

export const NATIVE_BASH_TOOL_NAME = "native_bash";

function bashToolDefinition(
  name: typeof NATIVE_BASH_TOOL_NAME,
  description: string
) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Bash command to run from the current Agent workbench."
        },
        timeoutMs: {
          type: ["integer", "null"],
          enum: [WORKSPACE_BASH_EXECUTION_TIMEOUT_MS, null],
          description: "Tool execution timeout is fixed at 30000 milliseconds. Use null to apply it."
        }
      },
      required: ["command", "timeoutMs"]
    },
    strict: true
  } as const;
}

export const nativeBashTool = bashToolDefinition(
  NATIVE_BASH_TOOL_NAME,
  "Run a Bash command after an independent adversarial approval agent reviews it. Linux and WSL use Bubblewrap with hard resource limits. macOS host execution is available only in administrator private conversations."
);
