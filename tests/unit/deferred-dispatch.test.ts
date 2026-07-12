import { describe, expect, it } from "vitest";
import {
  readDeferredDispatchMessage,
  withRequiredDispatchMessage,
  withoutDispatchMessage
} from "../../services/tools/deferredDispatch.js";

describe("deferred dispatch contract", () => {
  it("extracts the persona message and removes it from worker arguments", () => {
    expect(readDeferredDispatchMessage({
      task: "inspect",
      kind: "local",
      dispatch_message: "  我收到任务，开始检查。  "
    }, "codex")).toEqual({
      ok: true,
      message: "我收到任务，开始检查。",
      workerArguments: { task: "inspect", kind: "local" }
    });
  });

  it("rejects missing, blank and overlong messages", () => {
    expect(readDeferredDispatchMessage({ task: "inspect" }, "codex")).toMatchObject({ ok: false });
    expect(readDeferredDispatchMessage({ dispatch_message: "  " }, "codex")).toMatchObject({ ok: false });
    expect(readDeferredDispatchMessage({ dispatch_message: "x".repeat(201) }, "codex")).toMatchObject({
      ok: false,
      error: expect.stringContaining("200")
    });
  });

  it("overrides stale schemas for deferred mode and removes the field for inline mode", () => {
    const stale = {
      name: "generate_img",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          prompt: { type: "string" },
          dispatch_message: { type: "number" }
        },
        required: ["prompt"]
      },
      strict: false
    };
    const deferred = withRequiredDispatchMessage(stale);
    const parameters = deferred.parameters as Record<string, any>;
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.dispatch_message.type).toBe("string");
    expect(parameters.required).toEqual(["prompt", "dispatch_message"]);
    expect(deferred.strict).toBe(true);

    const inline = withoutDispatchMessage(deferred);
    const inlineParameters = inline.parameters as Record<string, any>;
    expect(inlineParameters.properties.dispatch_message).toBeUndefined();
    expect(inlineParameters.required).toEqual(["prompt"]);
  });
});
