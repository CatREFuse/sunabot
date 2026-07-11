// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AdminMutationMutex } from "../../src/admin/mutation.js";

describe("AdminMutationMutex", () => {
  it("serializes overlapping mutations", async () => {
    const mutex = new AdminMutationMutex();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.runExclusive(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = mutex.runExclusive(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("releases the next mutation after an error", async () => {
    const mutex = new AdminMutationMutex();
    const first = mutex.runExclusive(async () => {
      throw new Error("failed");
    });
    const second = mutex.runExclusive(async () => "continued");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("continued");
  });
});
