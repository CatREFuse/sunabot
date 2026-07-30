import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";

export function currentPromptInputMessage(
  request: RenderedPromptRequest,
  marker?: { start: string; end: string }
) {
  if (!marker) return [...request.messages].reverse().find((message) => message.role === "user");
  const currentUserMessage = [...request.messages].reverse().find((message) => (
    message.role === "user"
    && message.content.includes(marker.start)
    && message.content.includes(marker.end)
  ));
  for (const message of request.messages) {
    message.content = message.content
      .split(marker.start).join("")
      .split(marker.end).join("");
  }
  return currentUserMessage;
}
