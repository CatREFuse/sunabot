import { describe, expect, it } from "vitest";
import { sortByMemoryTime } from "./memorySort";

describe("sortByMemoryTime", () => {
  const items = [
    { id: "middle", updatedAt: "2026-07-20T02:00:00.000Z" },
    { id: "missing" },
    { id: "latest", updatedAt: "2026-07-20T03:00:00.000Z" },
    { id: "invalid", updatedAt: "invalid" },
    { id: "earliest", updatedAt: "2026-07-20T01:00:00.000Z" }
  ];

  it("sorts valid timestamps in both directions and always places missing values last", () => {
    expect(sortByMemoryTime(items, "updatedAt", "desc", (item) => item).map(({ id }) => id)).toEqual([
      "latest", "middle", "earliest", "missing", "invalid"
    ]);
    expect(sortByMemoryTime(items, "updatedAt", "asc", (item) => item).map(({ id }) => id)).toEqual([
      "earliest", "middle", "latest", "missing", "invalid"
    ]);
  });

  it("keeps the input order stable when timestamps match or are unavailable", () => {
    const stable = [
      { id: "first", createdAt: "2026-07-20T01:00:00.000Z" },
      { id: "second", createdAt: "2026-07-20T01:00:00.000Z" },
      { id: "third" }
    ];
    expect(sortByMemoryTime(stable, "createdAt", "desc", (item) => item).map(({ id }) => id)).toEqual([
      "first", "second", "third"
    ]);
  });
});
