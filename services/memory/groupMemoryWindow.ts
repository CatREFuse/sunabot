export const GROUP_MEMORY_MESSAGE_RADIUS = 20;
export const GROUP_MEMORY_SELECTION_POLICY = "assistant-neighborhood-v1";
export const GROUP_MEMORY_SELECTION_CONTEXT_LIMIT = GROUP_MEMORY_MESSAGE_RADIUS * 2 + 1;

export interface GroupMemoryWindowMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
}

export function isGroupMemoryScope(scope: string) {
  return scope === "user_group" || scope === "bot_group";
}

export function orderedUniqueMemoryMessages<T extends GroupMemoryWindowMessage>(
  messages: readonly T[]
) {
  const byKey = new Map<string, T>();
  for (const message of messages) byKey.set(memoryMessageKey(message), message);
  return [...byKey.values()].sort(compareMemoryMessages);
}

export function selectGroupMemoryMessagesNearAssistant<T extends GroupMemoryWindowMessage>(
  messages: readonly T[]
) {
  const ordered = orderedUniqueMemoryMessages(messages);
  const selected = new Set<number>();
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.role !== "assistant") continue;
    const start = Math.max(0, index - GROUP_MEMORY_MESSAGE_RADIUS);
    const end = Math.min(ordered.length - 1, index + GROUP_MEMORY_MESSAGE_RADIUS);
    for (let selectedIndex = start; selectedIndex <= end; selectedIndex += 1) {
      selected.add(selectedIndex);
    }
  }
  return ordered.filter((_, index) => selected.has(index));
}

function memoryMessageKey(message: GroupMemoryWindowMessage) {
  return `${message.sequence}:${message.id}`;
}

function compareMemoryMessages(left: GroupMemoryWindowMessage, right: GroupMemoryWindowMessage) {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}
