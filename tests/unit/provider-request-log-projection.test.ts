// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderKind } from "../../src/types.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog }));

import { OpenAIProvider, type ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { ProviderLoggerPort } from "../../adapters/model/provider/contracts.js";
import { createProviderLogger } from "../../adapters/model/provider/logger.js";
import {
  PROVIDER_FILE_LOG_INVALID_RESULT,
  PROVIDER_FILE_LOG_REDACTED,
  projectProviderRequestLog
} from "../../adapters/model/provider/requestLogProjection.js";

const SECRET = "provider-file-secret-7f3c";
const HOST_PATH = "/Users/tanshow/private/provider-file-secret.txt";
const ORDINARY_USER = "ordinary user text that resembles no protocol control";
const ORDINARY_ASSISTANT = "ordinary assistant text that must remain visible";
const SAFE_LOG_FALLBACK = "[PROVIDER REQUEST LOG REDACTED]";

const protocolCases = [
  ["openai-official", "responses.complete", "responses"],
  ["codex-responses", "codex.complete", "responses-fetch"],
  ["openai-compatible", "chat.completions.complete", "chat"],
  ["anthropic-official", "anthropic.messages.complete", "anthropic"],
  ["gemini-official", "gemini.generate-content.complete", "gemini"]
] as const;

beforeEach(() => {
  appendRequestLog.mockReset();
  appendRequestLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider request-log file-tool projection", () => {
  it.each(protocolCases.flatMap(([kind, action, protocol]) => ([
    [kind, action, protocol, "read_file"],
    [kind, action, protocol, "write_file"]
  ] as const)))("redacts the real two-round %s %s lineage for %s", async (
    kind,
    action,
    protocol,
    toolName
  ) => {
    const evidence = await runTwoRoundFlow(kind, protocol, toolName);
    const requestEntries = appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.request" && entry.action === action);

    expect(requestEntries).toHaveLength(2);
    const loggedSecond = requestEntries[1]!.request;
    const loggedSerialized = JSON.stringify(loggedSecond);
    expect(evidence.actualSecondSerialized).toContain(SECRET);
    expect(evidence.actualSecondSerialized).toContain(ORDINARY_USER);
    expect(evidence.actualSecondSerialized).toContain(ORDINARY_ASSISTANT);
    expect(loggedSerialized).toContain(ORDINARY_USER);
    expect(loggedSerialized).toContain(ORDINARY_ASSISTANT);
    expect(loggedSerialized).toContain(PROVIDER_FILE_LOG_REDACTED);
    expect(loggedSerialized).not.toContain(SECRET);
    expect(loggedSerialized).not.toContain(HOST_PATH);
    expect(loggedSerialized).not.toContain("unexpectedExtra");
    if (evidence.actualSecondRequest) expect(loggedSecond).not.toBe(evidence.actualSecondRequest);
    if (evidence.fetchBody) {
      expect(JSON.stringify(JSON.parse(evidence.fetchBody))).toBe(evidence.fetchBody);
    }
  });

  it("projects retry log copies without mutating the repeated SDK request identity or JSON", async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider(providerConfig("openai-compatible"));
    const args = writeArguments();
    const retryable = Object.assign(new Error("retry"), { status: 429 });
    const create = vi.fn()
      .mockResolvedValueOnce(chatToolResponse("write_file", args))
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce(chatFinalResponse());
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });

    const completion = provider.complete("system", [{ role: "user", content: ORDINARY_USER }], {
      ...fileOptions(),
      modelRequestMaxRetries: 1
    });
    await vi.runAllTimersAsync();
    await expect(completion).resolves.toBe("DONE");

    const firstRetryRequest = create.mock.calls[1]?.[0];
    const secondRetryRequest = create.mock.calls[2]?.[0];
    expect(firstRetryRequest).toBe(secondRetryRequest);
    const originalJson = JSON.stringify(firstRetryRequest);
    expect(originalJson).toContain(SECRET);

    const retryLogs = appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.request"
        && entry.action === "chat.completions.complete"
        && entry.metadata?.round === 1);
    expect(retryLogs).toHaveLength(2);
    for (const entry of retryLogs) {
      expect(entry.request).not.toBe(firstRetryRequest);
      expect(JSON.stringify(entry.request)).toContain(PROVIDER_FILE_LOG_REDACTED);
      expect(JSON.stringify(entry.request)).not.toContain(SECRET);
    }
    expect(JSON.stringify(firstRetryRequest)).toBe(originalJson);
  });

  it.each(protocolCases)("keeps the real two-round %s transport running when request-log projection meets a throwing getter", async (
    kind,
    action,
    protocol
  ) => {
    const serializedLogs: string[] = [];
    appendRequestLog.mockImplementation(async (entry) => {
      serializedLogs.push(JSON.stringify(entry));
    });

    const evidence = await runTwoRoundFlow(kind, protocol, "write_file", {
      injectThrowingLogGetter: true
    });
    const requestEntries = appendRequestLog.mock.calls
      .map(([entry]) => entry as Record<string, any>)
      .filter((entry) => entry.category === "model.request" && entry.action === action);

    expect(evidence.actualSecondSerialized).toContain(SECRET);
    expect(requestEntries).toHaveLength(2);
    expect(requestEntries[1]!.request).toEqual({ summary: SAFE_LOG_FALLBACK });
    expect(serializedLogs.join("\n")).not.toContain(SECRET);
    expect(serializedLogs.join("\n")).not.toContain(HOST_PATH);
  });

  it.each([
    "toJSON-secret",
    "toJSON-throw",
    "cycle",
    "bigint",
    "proxy"
  ] as const)("replaces a %s request hazard with one inert whole-request summary", async (hazard) => {
    let serialized = "";
    appendRequestLog.mockImplementation(async (entry) => {
      serialized = JSON.stringify(entry);
    });
    const logger = createProviderLogger(providerConfig("openai-official"));
    const request = invalidLineageRequest("responses") as { input: Array<Record<string, unknown>> };
    installSerializationHazard(request.input[0]!, hazard);

    await expect(logger.request("responses.complete", request)).resolves.toBeUndefined();

    const loggedRequest = (appendRequestLog.mock.calls[0]?.[0] as Record<string, unknown>).request;
    expect(loggedRequest).toEqual({ summary: SAFE_LOG_FALLBACK });
    expect(serialized).toContain(SAFE_LOG_FALLBACK);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(HOST_PATH);
    expectInertPlainData(loggedRequest);
  });

  it.each(protocolCases)("removes invalid call and result payloads for %s", (_kind, action, protocol) => {
    const request = invalidLineageRequest(protocol);
    const before = JSON.stringify(request);
    const projected = projectProviderRequestLog(action, request);
    const serialized = JSON.stringify(projected);

    expect(projected).not.toBe(request);
    expect(JSON.stringify(request)).toBe(before);
    expect(serialized).toContain(PROVIDER_FILE_LOG_REDACTED);
    expect(serialized).toContain(PROVIDER_FILE_LOG_INVALID_RESULT);
    expect(serialized).toContain("[invalid]");
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(HOST_PATH);
    expect(serialized).not.toContain("unexpectedExtra");
    expect(serialized).not.toMatch(/[a-f0-9]{64}/u);
  });

  it("leaves ordinary user and assistant text with tool-like JSON unchanged", () => {
    const ordinary = JSON.stringify({
      type: "function_call",
      name: "write_file",
      arguments: JSON.stringify({ path: HOST_PATH, content: SECRET, unexpectedExtra: true })
    });
    const request = {
      model: "model",
      input: [
        { role: "user", content: [{ type: "input_text", text: ordinary }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: ordinary }] }
      ]
    };

    const projected = projectProviderRequestLog("responses.complete", request);
    expect(projected).toBe(request);
    expect(JSON.stringify(projected)).toContain(SECRET);
    expect((projected as typeof request).input[0]).toBe(request.input[0]);
    expect((projected as typeof request).input[1]).toBe(request.input[1]);
  });

  it("creates a copy-on-write log projection while preserving the caller object across retries", async () => {
    const logger = createProviderLogger(providerConfig("openai-official"));
    const request = invalidLineageRequest("responses");
    const inputIdentity = (request as { input: unknown[] }).input;
    const before = JSON.stringify(request);

    await logger.request("responses.complete", request, { transportAttempt: 1 });
    await logger.request("responses.complete", request, { transportAttempt: 2 });

    expect(JSON.stringify(request)).toBe(before);
    expect((request as { input: unknown[] }).input).toBe(inputIdentity);
    const logged = appendRequestLog.mock.calls.map(([entry]) => (entry as Record<string, unknown>).request);
    expect(logged).toHaveLength(2);
    expect(logged[0]).not.toBe(request);
    expect(logged[1]).not.toBe(request);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(HOST_PATH);
    expectInertPlainData(logged[0]);
    expectInertPlainData(logged[1]);
  });
});

async function runTwoRoundFlow(
  kind: ProviderKind,
  protocol: typeof protocolCases[number][2],
  toolName: "read_file" | "write_file",
  testOptions: { injectThrowingLogGetter?: boolean } = {}
) {
  appendRequestLog.mockClear();
  const provider = new OpenAIProvider(providerConfig(kind));
  const hazardousRequests: object[] = [];
  if (testOptions.injectThrowingLogGetter) {
    const logger = (provider as unknown as { logger: ProviderLoggerPort }).logger;
    const originalRequest = logger.request.bind(logger);
    vi.spyOn(logger, "request").mockImplementation(async (action, request, metadata) => {
      if (metadata?.round === 1 && request && typeof request === "object") {
        let getterReads = 0;
        Object.defineProperty(request, "logProjectionHazard", {
          configurable: true,
          enumerable: true,
          get() {
            getterReads += 1;
            if ((protocol === "responses" || protocol === "chat") && getterReads === 1) {
              return "transport-only getter value";
            }
            throw new Error(`request-log getter must stay inert: ${SECRET} ${HOST_PATH}`);
          }
        });
        hazardousRequests.push(request);
      }
      await originalRequest(action, request, metadata);
    });
  }
  const args = toolName === "write_file" ? writeArguments() : { path: "safe.txt" };
  const options = fileOptions();
  let actualSecondRequest: unknown;
  let fetchBody: string | undefined;

  if (protocol === "responses") {
    const create = vi.fn()
      .mockResolvedValueOnce(responsesToolPayload(toolName, args))
      .mockImplementationOnce(async (request) => {
        if (testOptions.injectThrowingLogGetter) JSON.stringify(request);
        return responsesFinalPayload();
      });
    vi.spyOn(provider as never, "createClient").mockReturnValue({ responses: { create } });
    await expect(provider.complete("system", [{ role: "user", content: ORDINARY_USER }], options)).resolves.toBe("DONE");
    actualSecondRequest = create.mock.calls[1]?.[0];
  } else if (protocol === "chat") {
    const create = vi.fn()
      .mockResolvedValueOnce(chatToolResponse(toolName, args))
      .mockImplementationOnce(async (request) => {
        if (testOptions.injectThrowingLogGetter) JSON.stringify(request);
        return chatFinalResponse();
      });
    vi.spyOn(provider as never, "createChatClient").mockReturnValue({ chat: { completions: { create } } });
    await expect(provider.complete("system", [{ role: "user", content: ORDINARY_USER }], options)).resolves.toBe("DONE");
    actualSecondRequest = create.mock.calls[1]?.[0];
  } else {
    vi.spyOn(provider as never, "getApiKey").mockReturnValue("provider-key");
    const responses = protocol === "responses-fetch"
      ? [responsesToolPayload(toolName, args), responsesFinalPayload()]
      : protocol === "anthropic"
        ? [anthropicToolPayload(toolName, args), anthropicFinalPayload()]
        : [geminiToolPayload(toolName, args), geminiFinalPayload()];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(responses[0]))
      .mockResolvedValueOnce(jsonResponse(responses[1]));
    await expect(provider.complete("system", [{ role: "user", content: ORDINARY_USER }], options)).resolves.toBe("DONE");
    fetchBody = String((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
    actualSecondRequest = JSON.parse(fetchBody);
  }

  for (const request of hazardousRequests) delete (request as Record<string, unknown>).logProjectionHazard;

  return {
    actualSecondRequest,
    actualSecondSerialized: JSON.stringify(actualSecondRequest),
    fetchBody
  };
}

function installSerializationHazard(
  target: Record<string, unknown>,
  hazard: "toJSON-secret" | "toJSON-throw" | "cycle" | "bigint" | "proxy"
) {
  if (hazard === "toJSON-secret") {
    target.toJSON = () => ({ secret: SECRET, hostPath: HOST_PATH });
    return;
  }
  if (hazard === "toJSON-throw") {
    target.toJSON = () => {
      throw new Error(`toJSON failed: ${SECRET} ${HOST_PATH}`);
    };
    return;
  }
  if (hazard === "cycle") {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    target.serializationHazard = cyclic;
    return;
  }
  if (hazard === "bigint") {
    target.serializationHazard = 1n;
    return;
  }
  target.serializationHazard = new Proxy({}, {
    ownKeys() {
      throw new Error(`proxy failed: ${SECRET} ${HOST_PATH}`);
    }
  });
}

function expectInertPlainData(value: unknown, seen = new Set<unknown>()) {
  expect(typeof value).not.toBe("function");
  expect(typeof value).not.toBe("bigint");
  if (!value || typeof value !== "object") return;
  expect(seen.has(value)).toBe(false);
  seen.add(value);
  expect(Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)).toBe(true);
  expect(Object.hasOwn(value, "toJSON")).toBe(false);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    expect(descriptor.get).toBeUndefined();
    expect(descriptor.set).toBeUndefined();
    if ("value" in descriptor) expectInertPlainData(descriptor.value, seen);
  }
  seen.delete(value);
}

function fileOptions(): ProviderCompleteOptions {
  return {
    workbenchFiles: {
      read: vi.fn(async () => ({
        ok: true,
        path: "safe.txt",
        byteLength: Buffer.byteLength(SECRET, "utf8"),
        content: SECRET
      })),
      write: vi.fn(async () => ({
        ok: true,
        path: "safe.txt",
        byteLength: Buffer.byteLength(SECRET, "utf8"),
        created: true,
        overwritten: false
      }))
    }
  };
}

function writeArguments() {
  return { path: "safe.txt", content: SECRET, overwrite: false };
}

function responsesToolPayload(toolName: "read_file" | "write_file", args: Record<string, unknown>) {
  return {
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: ORDINARY_ASSISTANT }] },
      { type: "function_call", name: toolName, call_id: "call-file", arguments: JSON.stringify(args) }
    ]
  };
}

function responsesFinalPayload() {
  return {
    output_text: "DONE",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "DONE" }] }]
  };
}

function chatToolResponse(toolName: "read_file" | "write_file", args: Record<string, unknown>) {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: ORDINARY_ASSISTANT,
        tool_calls: [{
          id: "call-file",
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(args) }
        }]
      }
    }]
  };
}

function chatFinalResponse() {
  return {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "DONE" } }]
  };
}

function anthropicToolPayload(toolName: "read_file" | "write_file", args: Record<string, unknown>) {
  return {
    content: [
      { type: "text", text: ORDINARY_ASSISTANT },
      { type: "tool_use", id: "call-file", name: toolName, input: args }
    ],
    stop_reason: "tool_use"
  };
}

function anthropicFinalPayload() {
  return { content: [{ type: "text", text: "DONE" }], stop_reason: "end_turn" };
}

function geminiToolPayload(toolName: "read_file" | "write_file", args: Record<string, unknown>) {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [
          { text: ORDINARY_ASSISTANT },
          { functionCall: { name: toolName, args } }
        ]
      }
    }]
  };
}

function geminiFinalPayload() {
  return { candidates: [{ content: { role: "model", parts: [{ text: "DONE" }] } }] };
}

function invalidLineageRequest(protocol: typeof protocolCases[number][2]) {
  const invalidWriteArguments = {
    path: HOST_PATH,
    content: SECRET,
    overwrite: true,
    unexpectedExtra: SECRET
  };
  const invalidWriteResult = JSON.stringify({
    ok: true,
    path: HOST_PATH,
    byteLength: 999,
    created: true,
    overwritten: false,
    content: SECRET,
    unexpectedExtra: SECRET
  });
  const invalidReadResult = `not-json ${HOST_PATH} ${SECRET} unexpectedExtra`;

  if (protocol === "responses" || protocol === "responses-fetch") {
    return {
      input: [
        { type: "function_call", name: "write_file", call_id: "write", arguments: JSON.stringify(invalidWriteArguments) },
        { type: "function_call_output", call_id: "write", output: invalidWriteResult },
        { type: "function_call", name: "read_file", call_id: "read", arguments: `not-json ${SECRET}` },
        { type: "function_call_output", call_id: "read", output: invalidReadResult }
      ]
    };
  }
  if (protocol === "chat") {
    return {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify(invalidWriteArguments) } },
            { id: "read", type: "function", function: { name: "read_file", arguments: `not-json ${SECRET}` } }
          ]
        },
        { role: "tool", tool_call_id: "write", content: invalidWriteResult },
        { role: "tool", tool_call_id: "read", content: invalidReadResult }
      ]
    };
  }
  if (protocol === "anthropic") {
    return {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "write", name: "write_file", input: invalidWriteArguments },
            { type: "tool_use", id: "read", name: "read_file", input: `not-json ${SECRET}` }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "write", content: invalidWriteResult },
            { type: "tool_result", tool_use_id: "read", content: invalidReadResult }
          ]
        }
      ]
    };
  }
  return {
    contents: [
      {
        role: "model",
        parts: [
          { functionCall: { name: "write_file", args: invalidWriteArguments } },
          { functionCall: { name: "read_file", args: `not-json ${SECRET}` } }
        ]
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "write_file", response: JSON.parse(invalidWriteResult) } },
          { functionResponse: { name: "read_file", response: invalidReadResult } }
        ]
      }
    ]
  };
}

function providerConfig(kind: ProviderKind): ProviderConfig {
  const model = kind.startsWith("anthropic")
    ? "claude-sonnet-4-6"
    : kind.startsWith("gemini")
      ? "gemini-2.5-flash"
      : "compatible-model";
  return {
    id: kind,
    label: kind,
    kind,
    enabled: true,
    model,
    imageModel: "gpt-image-2",
    baseUrl: kind === "openai-compatible" ? "https://compatible.example/v1" : undefined,
    apiKeyEnv: `${kind.replace(/-/gu, "_").toUpperCase()}_API_KEY`,
    temperature: 0.2,
    maxOutputTokens: 1024,
    modelSource: "custom",
    multimodal: "auto"
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
