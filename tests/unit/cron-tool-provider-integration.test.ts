// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import {
  localOutboundTurnConflict,
  preflightProviderToolResponse
} from "../../adapters/model/provider/toolResponsePreflight.js";
import { createTurnToolState } from "../../adapters/model/provider/turnToolState.js";

const LIST_INPUT = {
  operation: "list",
  taskId: null,
  revision: null,
  name: null,
  enabled: null,
  schedule: null,
  context: null,
  targets: null
};

describe("cron provider integration", () => {
  it("declares and executes the single cron tool only when its turn port exists", async () => {
    const execute = vi.fn(async () => ({ ok: true, operation: "list", tasks: [] }));
    const options = { cron: { execute } } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    expect(definitions.map((definition) => definition.name)).toContain("cron");

    const output = await executor.execute([call("cron-list", "cron", LIST_INPUT)], options, definitions);
    expect(JSON.parse(String(output[0]?.output))).toEqual({ ok: true, operation: "list", tasks: [] });
    expect(execute).toHaveBeenCalledWith(LIST_INPUT);
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
      category: "tool.call",
      action: "cron"
    }));

    const unavailableDefinitions = executor.resolveDefinitions({}, []);
    expect(unavailableDefinitions.map((definition) => definition.name)).not.toContain("cron");
  });

  it("rejects cron batches and sibling text before the port can mutate state", async () => {
    const execute = vi.fn();
    const options = { cron: { execute } } satisfies ProviderCompleteOptions;
    const state = createTurnToolState();
    const cron = call("cron-create", "cron", LIST_INPUT);
    const text = preflightProviderToolResponse([cron], "任务已创建", options, state);
    expect(outputs(text.rejected)).toEqual([
      { ok: false, error: "cron must be called without sibling assistant text in the same model response." }
    ]);

    const batch = preflightProviderToolResponse([
      cron,
      call("assistant", "assistant_text", { text: "完成" })
    ], "", options, state);
    expect(outputs(batch.rejected)).toEqual([
      { ok: false, error: "cron must be called alone before any other tool." },
      { ok: false, error: "cron must be called alone before any other tool." }
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats cron as local data and rejects an outbound-network batch", () => {
    const state = createTurnToolState();
    state.acceptedToolNames.push("cron");
    expect(localOutboundTurnConflict(
      "websearch",
      state,
      { cron: { execute: vi.fn() } }
    )).toBe(true);
  });
});

function call(callId: string, name: string, args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    call_id: callId,
    name,
    arguments: JSON.stringify(args)
  };
}

function outputs(value: ReturnType<typeof preflightProviderToolResponse>["rejected"]) {
  return (value ?? []).map((item) => JSON.parse(String(item.output)));
}
