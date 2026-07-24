import { describe, expect, it } from "vitest";
import { buildCallbackInput } from "../../services/agent/callbackInput.js";
import {
  isDirectorScheduledTaskId,
  scheduledCallbackTaskId
} from "../../src/runtime/scheduledTaskDirectorBoundary.js";

describe("scheduled task Director boundary", () => {
  it("classifies only the reserved Director task id prefix", () => {
    expect(isDirectorScheduledTaskId("director-plana-20260723-share-r1-c1")).toBe(true);
    expect(isDirectorScheduledTaskId("scheduled-director-plana")).toBe(false);
    expect(isDirectorScheduledTaskId("ordinary-task")).toBe(false);
    expect(isDirectorScheduledTaskId("")).toBe(false);
  });

  it("extracts the frozen task id from a legacy scheduled callback", () => {
    const text = buildCallbackInput("scheduled_task", {
      promptMessages: [{
        role: "user",
        content: `<cron_payload>${JSON.stringify({
          task: { id: "director-plana-20260723-share-r1-c1" }
        })}</cron_payload>`
      }]
    });

    expect(scheduledCallbackTaskId(text)).toBe("director-plana-20260723-share-r1-c1");
  });

  it("skips malformed and unrelated callback content without classifying it as Director", () => {
    const malformedThenOrdinary = buildCallbackInput("scheduled_task", {
      promptMessages: [
        { role: "user", content: "<cron_payload>{broken}</cron_payload>" },
        {
          role: "user",
          content: `<cron_payload>${JSON.stringify({ task: { id: "ordinary-task" } })}</cron_payload>`
        }
      ]
    });

    expect(scheduledCallbackTaskId(malformedThenOrdinary)).toBe("ordinary-task");
    expect(scheduledCallbackTaskId(buildCallbackInput("other", {
      promptMessages: [{
        role: "user",
        content: "<cron_payload>{\"task\":{\"id\":\"director-forged\"}}</cron_payload>"
      }]
    }))).toBeUndefined();
    expect(scheduledCallbackTaskId("director-plana-20260723-share-r1-c1")).toBeUndefined();
    expect(scheduledCallbackTaskId("")).toBeUndefined();
  });
});
