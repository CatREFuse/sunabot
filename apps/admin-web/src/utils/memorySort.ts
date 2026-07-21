export const memorySortFields = ["createdAt", "updatedAt", "lastRecalledAt"] as const;
export type MemorySortField = typeof memorySortFields[number];
export type MemorySortDirection = "asc" | "desc";
export type MemorySortTimes = Partial<Record<MemorySortField, string>>;

export function sortByMemoryTime<T>(
  items: readonly T[],
  field: MemorySortField,
  direction: MemorySortDirection,
  timesFor: (item: T) => MemorySortTimes
) {
  return items
    .map((item, index) => ({ item, index, timestamp: parseTimestamp(timesFor(item)[field]) }))
    .sort((left, right) => {
      if (left.timestamp == null && right.timestamp == null) return left.index - right.index;
      if (left.timestamp == null) return 1;
      if (right.timestamp == null) return -1;
      const difference = left.timestamp - right.timestamp;
      if (difference === 0) return left.index - right.index;
      return direction === "asc" ? difference : -difference;
    })
    .map(({ item }) => item);
}

function parseTimestamp(value?: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
