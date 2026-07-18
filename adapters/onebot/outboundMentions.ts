const MAX_ONEBOT_MENTION_USER_IDS = 20;

export function normalizeMentionUserIds(mentionUserIds: readonly number[] | undefined) {
  if (mentionUserIds === undefined) return [];
  if (!Array.isArray(mentionUserIds)) {
    throw new Error("Outbound mention user IDs must be an array.");
  }
  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const userId of mentionUserIds) {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("Outbound mention user IDs must contain only positive safe integers.");
    }
    if (seen.has(userId)) continue;
    seen.add(userId);
    normalized.push(userId);
  }
  if (normalized.length > MAX_ONEBOT_MENTION_USER_IDS) {
    throw new Error(`Outbound mention user IDs cannot exceed ${MAX_ONEBOT_MENTION_USER_IDS} unique users.`);
  }
  return normalized;
}
