// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog }));

import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import { createTurnToolState } from "../../adapters/model/provider/turnToolState.js";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";

describe("read_file and write_file provider contract", () => {
  beforeEach(() => {
    appendRequestLog.mockClear();
  });

  it("injects strict canonical schemas over missing or stale prompt definitions", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = fileOptions();
    const definitions = executor.resolveDefinitions(options, [{
      type: "function",
      function: {
        name: "read_file",
        description: "stale",
        parameters: { type: "object", additionalProperties: true, properties: { hostPath: { type: "string" } } },
        strict: false
      }
    }]);
    const read = definitions.find((tool) => tool.name === "read_file") as Record<string, any>;
    const write = definitions.find((tool) => tool.name === "write_file") as Record<string, any>;

    expect(read).toMatchObject({
      name: "read_file",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"]
      }
    });
    expect(read.parameters.properties).toEqual({ path: expect.objectContaining({ type: "string" }) });
    expect(write).toMatchObject({
      name: "write_file",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "overwrite"]
      }
    });
    expect(write.parameters.properties).toEqual({
      path: expect.objectContaining({ type: "string" }),
      content: expect.objectContaining({ type: "string" }),
      overwrite: expect.objectContaining({ type: "boolean" })
    });
    expect(read.parameters.properties.hostPath).toBeUndefined();
  });

  it.each(["read_file", "write_file"])("rejects a forged %s call without a runtime port", async (name) => {
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions({}, []);
    const [output] = await executor.execute([fileCall(name, name === "read_file"
      ? { path: "safe.txt" }
      : { path: "safe.txt", content: "x", overwrite: false })], {}, definitions);

    expect(definitions).toEqual([]);
    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: `Tool ${name} is unavailable.` });
  });

  it("validates exact canonical arguments before invoking a custom port", async () => {
    const cases = [
      ["read_file", { path: "safe.txt", extra: true }, "WORKBENCH_FILE_ARGUMENTS_INVALID"],
      ["read_file", { path: "/Users/tanshow/private/secret.txt" }, "WORKBENCH_FILE_ARGUMENTS_INVALID"],
      ["read_file", { path: "cafe\u0301.txt" }, "WORKBENCH_FILE_ARGUMENTS_INVALID"],
      ["write_file", { path: "safe.txt", content: "x", overwrite: false, extra: true }, "WORKBENCH_FILE_ARGUMENTS_INVALID"],
      ["write_file", { path: "safe.txt", content: "secret\u0000text", overwrite: false }, "WORKBENCH_FILE_ARGUMENTS_INVALID"],
      ["write_file", { path: "safe.txt", content: "x", overwrite: "false" }, "WORKBENCH_FILE_ARGUMENTS_INVALID"]
    ] as const;

    for (const [name, args, expectedCode] of cases) {
      appendRequestLog.mockClear();
      const read = vi.fn(async () => ({ ok: true, path: "safe.txt", byteLength: 1, content: "x" }));
      const write = vi.fn(async () => ({
        ok: true,
        path: "safe.txt",
        byteLength: 1,
        created: true,
        overwritten: false
      }));
      const options = { workbenchFiles: { read, write } } satisfies ProviderCompleteOptions;
      const executor = new RegistryProviderToolExecutor();
      const definitions = executor.resolveDefinitions(options, []);
      const [output] = await executor.execute([fileCall(name, args)], options, definitions);

      expect(JSON.parse(String(output?.output)), name).toEqual({
        ok: false,
        code: expectedCode,
        error: "File tool arguments are invalid."
      });
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(JSON.stringify(appendRequestLog.mock.calls)).not.toContain("secret");
      expect(JSON.stringify(appendRequestLog.mock.calls)).not.toContain("/Users/");
    }
  });

  it("rejects a file tool mixed with assistant_text before either callback runs", async () => {
    const read = vi.fn(async () => ({ ok: true, path: "safe.txt", byteLength: 1, content: "x" }));
    const write = vi.fn(async () => ({ ok: true, path: "safe.txt", byteLength: 1 }));
    const onAssistantText = vi.fn();
    const executor = new RegistryProviderToolExecutor();
    const options = { workbenchFiles: { read, write }, onAssistantText } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options, []);
    const outputs = await executor.execute([
      fileCall("read_file", { path: "safe.txt" }),
      fileCall("assistant_text", { text: "do not send" })
    ], options, definitions);

    expect(outputs.map((output) => JSON.parse(String(output.output)))).toEqual([
      { ok: false, error: "read_file and write_file must be called alone before any other tool." },
      { ok: false, error: "read_file and write_file must be called alone before any other tool." }
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(onAssistantText).not.toHaveBeenCalled();
  });

  it("rejects file tools before and after any accepted tool activity", async () => {
    const options = fileOptions();
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const state = createTurnToolState();
    state.acceptedToolNames.push("memory_recall");
    const [lateRead] = await executor.execute([fileCall("read_file", { path: "safe.txt" })], options, definitions, state);
    expect(JSON.parse(String(lateRead?.output))).toMatchObject({ ok: false });
    expect(options.workbenchFiles.read).not.toHaveBeenCalled();

    const freshState = createTurnToolState();
    const [write] = await executor.execute([
      fileCall("write_file", { path: "safe.txt", content: "x", overwrite: false })
    ], options, definitions, freshState);
    expect(JSON.parse(String(write?.output))).toMatchObject({ ok: true });
    const [lateReadAfterWrite] = await executor.execute([
      fileCall("read_file", { path: "safe.txt" })
    ], options, definitions, freshState);
    expect(JSON.parse(String(lateReadAfterWrite?.output))).toMatchObject({ ok: false });
    expect(options.workbenchFiles.read).not.toHaveBeenCalled();
  });

  it("returns a stable redacted failure if a custom port throws host metadata", async () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      workbenchFiles: {
        read: vi.fn(async () => {
          throw Object.assign(new Error("EIO /Users/tanshow/private/secret.txt"), {
            path: "/Users/tanshow/private/secret.txt",
            syscall: "read"
          });
        }),
        write: vi.fn()
      }
    } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute([fileCall("read_file", { path: "safe.txt" })], options, definitions);
    const result = JSON.parse(String(output?.output));

    expect(result).toEqual({
      ok: false,
      code: "WORKBENCH_FILE_UNAVAILABLE",
      error: "The workbench file operation is unavailable."
    });
    expect(JSON.stringify(result)).not.toContain("/Users/");
  });

  it("normalizes untrusted port results and request logs without file content or host paths", async () => {
    const hostPath = "/Users/tanshow/private/secret.txt";
    const executor = new RegistryProviderToolExecutor();
    const options = {
      workbenchFiles: {
        read: vi.fn(),
        write: vi.fn(async () => ({
          ok: false,
          code: "WORKBENCH_FILE_UNAVAILABLE",
          error: `EIO ${hostPath}`,
          path: hostPath,
          content: `secret from ${hostPath}`
        }))
      }
    } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute([fileCall("write_file", {
      path: hostPath,
      content: `secret from ${hostPath}`,
      overwrite: false
    })], options, definitions);

    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      code: "WORKBENCH_FILE_ARGUMENTS_INVALID",
      error: "File tool arguments are invalid."
    });
    expect(options.workbenchFiles.write).not.toHaveBeenCalled();
    expect(JSON.stringify(appendRequestLog.mock.calls)).not.toContain(hostPath);
    expect(JSON.stringify(appendRequestLog.mock.calls)).not.toContain("secret from");
  });

  it("accepts U+FFFD but rejects non-canonical paths and non-well-formed read content from a custom port", async () => {
    const validExecutor = new RegistryProviderToolExecutor();
    const validOptions = {
      workbenchFiles: {
        read: vi.fn(async () => ({
          ok: true,
          path: "raw-\ufffd.txt",
          byteLength: 1,
          content: "x"
        })),
        write: vi.fn()
      }
    } satisfies ProviderCompleteOptions;
    const validDefinitions = validExecutor.resolveDefinitions(validOptions, []);
    const [validOutput] = await validExecutor.execute([
      fileCall("read_file", { path: "raw-\ufffd.txt" })
    ], validOptions, validDefinitions);
    expect(JSON.parse(String(validOutput?.output))).toEqual({
      ok: true,
      path: "raw-\ufffd.txt",
      byteLength: 1,
      content: "x"
    });

    for (const [label, result] of [
      ["lone surrogate path", { ok: true, path: "secret-\ud800.txt", byteLength: 1, content: "x" }],
      ["NFD path", { ok: true, path: "secret-cafe\u0301.txt", byteLength: 1, content: "x" }],
      ["lone surrogate content", {
        ok: true,
        path: "safe.txt",
        byteLength: Buffer.byteLength("secret-\ud800", "utf8"),
        content: "secret-\ud800"
      }]
    ] as const) {
      appendRequestLog.mockClear();
      const executor = new RegistryProviderToolExecutor();
      const options = {
        workbenchFiles: {
          read: vi.fn(async () => result),
          write: vi.fn()
        }
      } satisfies ProviderCompleteOptions;
      const definitions = executor.resolveDefinitions(options, []);
      const [output] = await executor.execute([
        fileCall("read_file", { path: "safe.txt" })
      ], options, definitions);

      expect(JSON.parse(String(output?.output)), label).toEqual({
        ok: false,
        code: "WORKBENCH_FILE_UNAVAILABLE",
        error: "The workbench file operation is unavailable."
      });
      expect(JSON.stringify(appendRequestLog.mock.calls), label).not.toContain("secret-");
    }
  });

  it.each([
    [true, true],
    [false, false]
  ])("rejects contradictory write success flags created=%s overwritten=%s", async (created, overwritten) => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      workbenchFiles: {
        read: vi.fn(),
        write: vi.fn(async () => ({
          ok: true,
          path: "safe.txt",
        byteLength: 1,
        created,
        overwritten
        }))
      }
    } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute([fileCall("write_file", {
      path: "safe.txt",
      content: "x",
      overwrite: false
    })], options, definitions);

    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      code: "WORKBENCH_FILE_UNAVAILABLE",
      error: "The workbench file operation is unavailable."
    });
  });

  it.each([
    [
      "read path differs from the request",
      "read_file",
      { path: "safe.txt" },
      { ok: true, path: "other.txt", byteLength: 1, content: "x" }
    ],
    [
      "read content contains controls",
      "read_file",
      { path: "safe.txt" },
      { ok: true, path: "safe.txt", byteLength: 11, content: "secret\u0000text" }
    ],
    [
      "read byte length differs",
      "read_file",
      { path: "safe.txt" },
      { ok: true, path: "safe.txt", byteLength: 999, content: "secret-text" }
    ],
    [
      "read success contains extra fields",
      "read_file",
      { path: "safe.txt" },
      { ok: true, path: "safe.txt", byteLength: 1, content: "x", hostPath: "/Users/tanshow/private/secret.txt" }
    ],
    [
      "write path differs from the request",
      "write_file",
      { path: "safe.txt", content: "x", overwrite: false },
      { ok: true, path: "other.txt", byteLength: 1, created: true, overwritten: false }
    ],
    [
      "write byte length differs",
      "write_file",
      { path: "safe.txt", content: "x", overwrite: false },
      { ok: true, path: "safe.txt", byteLength: 999, created: true, overwritten: false }
    ],
    [
      "write success contains extra fields",
      "write_file",
      { path: "safe.txt", content: "x", overwrite: false },
      {
        ok: true,
        path: "safe.txt",
        byteLength: 1,
        created: true,
        overwritten: false,
        content: "secret from /Users/tanshow/private/secret.txt"
      }
    ]
  ] as const)("rejects custom port success when %s", async (_label, name, args, portResult) => {
    appendRequestLog.mockClear();
    const read = vi.fn(async () => portResult);
    const write = vi.fn(async () => portResult);
    const options = { workbenchFiles: { read, write } } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute([fileCall(name, args)], options, definitions);

    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      code: "WORKBENCH_FILE_UNAVAILABLE",
      error: "The workbench file operation is unavailable."
    });
    expect(name === "read_file" ? read : write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(appendRequestLog.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(appendRequestLog.mock.calls)).not.toContain("/Users/");
  });
});

function fileOptions() {
  return {
    workbenchFiles: {
      read: vi.fn(async () => ({ ok: true, path: "safe.txt", byteLength: 1, content: "x" })),
      write: vi.fn(async () => ({
        ok: true,
        path: "safe.txt",
        byteLength: 1,
        created: true,
        overwritten: false
      }))
    }
  } satisfies ProviderCompleteOptions;
}

function fileCall(name: string, args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    name,
    call_id: `call-${name}`,
    arguments: JSON.stringify(args)
  };
}
