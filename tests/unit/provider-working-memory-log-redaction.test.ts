// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROVIDER_FILE_LOG_REDACTED,
  PROVIDER_USER_PROFILE_LOG_REDACTED,
  PROVIDER_WORKMEMORY_LOG_REDACTED,
  projectAddUserProfileArgumentsLog,
  projectAddUserProfileResultLog,
  projectAddWorkMemoryResultLog,
  projectProviderRequestLogForStorage,
  projectProviderResponseLogForStorage
} from "../../adapters/model/provider/requestLogProjection.js";

const MEMORY_BODY_SENTINEL = "MEMORY_BODY_SENTINEL";
const RESULT_ERROR_SENTINEL = "RESULT_ERROR_SENTINEL";
const UNKNOWN_PROPERTY_SENTINEL = "SK_LIVE_SECRET_PROPERTY";
const UNKNOWN_CODE_SENTINEL = "SK_LIVE_SECRET_CODE";
const callArguments = {
  action: "record",
  content: MEMORY_BODY_SENTINEL,
  [UNKNOWN_PROPERTY_SENTINEL]: RESULT_ERROR_SENTINEL
};
const callResult = {
  ok: false,
  action: "record",
  code: UNKNOWN_CODE_SENTINEL,
  error: RESULT_ERROR_SENTINEL,
  message: RESULT_ERROR_SENTINEL,
  deduplicated: false,
  [UNKNOWN_PROPERTY_SENTINEL]: RESULT_ERROR_SENTINEL
};

describe("Provider add_workmemory log redaction", () => {
  it("redacts add_user_profile text and address names while retaining bounded status", () => {
    const argumentsLog = projectAddUserProfileArgumentsLog({
      action: "record",
      profile: "PROFILE_SECRET",
      addressNames: ["老师", "Tan"]
    });
    const resultLog = projectAddUserProfileResultLog({
      ok: true,
      action: "record",
      profileId: "user_profile_171419991",
      addressNameCount: 2,
      message: "PROFILE_SECRET"
    });
    const text = JSON.stringify({ argumentsLog, resultLog });

    expect(text).not.toContain("PROFILE_SECRET");
    expect(text).not.toContain("老师");
    expect(text).not.toContain("Tan");
    expect(text).toContain(PROVIDER_USER_PROFILE_LOG_REDACTED);
    expect(resultLog).toMatchObject({
      ok: true,
      action: "record",
      addressNameCount: 2
    });
    expect(resultLog).not.toHaveProperty("profileId");
  });

  it.each(providerLogCases())(
    "redacts call content and error detail while retaining status on $label",
    ({ action, request, response }) => {
      const projectedRequest = projectProviderRequestLogForStorage(action, request);
      const projectedResponse = projectProviderResponseLogForStorage(action, response);
      const requestText = JSON.stringify(projectedRequest);
      const responseText = JSON.stringify(projectedResponse);

      expect(requestText).not.toContain(MEMORY_BODY_SENTINEL);
      expect(requestText).not.toContain(RESULT_ERROR_SENTINEL);
      expect(requestText).not.toContain(UNKNOWN_PROPERTY_SENTINEL);
      expect(requestText).not.toContain(UNKNOWN_CODE_SENTINEL);
      expect(responseText).not.toContain(MEMORY_BODY_SENTINEL);
      expect(responseText).not.toContain(RESULT_ERROR_SENTINEL);
      expect(responseText).not.toContain(UNKNOWN_PROPERTY_SENTINEL);
      expect(responseText).not.toContain(UNKNOWN_CODE_SENTINEL);
      expect(requestText).toContain(PROVIDER_WORKMEMORY_LOG_REDACTED);
      expect(responseText).toContain(PROVIDER_WORKMEMORY_LOG_REDACTED);
      expect(projectedRecords(projectedRequest)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "record",
          argumentKeys: ["action", "content"],
          unsupportedArgumentCount: 1,
          content: PROVIDER_WORKMEMORY_LOG_REDACTED,
          contentChars: 20
        }),
        expect.objectContaining({
          ok: false,
          action: "record",
          code: "[invalid]",
          deduplicated: false
        })
      ]));
      expect(projectedRecords(projectedResponse)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "record",
          argumentKeys: ["action", "content"],
          unsupportedArgumentCount: 1,
          content: PROVIDER_WORKMEMORY_LOG_REDACTED,
          contentChars: 20
        })
      ]));
    }
  );

  it("keeps existing file-tool projection and unrelated tool payload behavior unchanged", () => {
    const writeContent = "WRITE_FILE_SENTINEL";
    const ordinaryContent = "ORDINARY_TOOL_SENTINEL";
    const projected = projectProviderRequestLogForStorage("responses.complete", {
      tools: [],
      input: [
        {
          type: "function_call",
          call_id: "write-call",
          name: "write_file",
          arguments: JSON.stringify({
            path: "result.txt",
            content: writeContent,
            overwrite: false
          })
        },
        {
          type: "function_call",
          call_id: "ordinary-call",
          name: "knowledge_search",
          arguments: JSON.stringify({ query: ordinaryContent })
        }
      ]
    });
    const text = JSON.stringify(projected);

    expect(text).not.toContain(writeContent);
    expect(text).toContain(PROVIDER_FILE_LOG_REDACTED);
    expect(projectedRecords(projected)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "result.txt",
        overwrite: false,
        contentByteLength: 19,
        content: PROVIDER_FILE_LOG_REDACTED
      })
    ]));
    expect(text).toContain(ordinaryContent);
  });

  it("uses the same safe result summary for the dedicated tool-call audit", () => {
    const projected = projectAddWorkMemoryResultLog({
      ...callResult,
      code: "WORKING_MEMORY_CONFLICT"
    });
    const text = JSON.stringify(projected);

    expect(text).not.toContain(RESULT_ERROR_SENTINEL);
    expect(projected).toEqual({
      ok: false,
      action: "record",
      code: "WORKING_MEMORY_CONFLICT",
      deduplicated: false
    });
  });
});

function projectedRecords(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return projectedRecords(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(projectedRecords);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(projectedRecords)];
}

function providerLogCases() {
  const jsonArguments = JSON.stringify(callArguments);
  const jsonResult = JSON.stringify(callResult);
  const responsesRequest = {
    tools: [],
    input: [
      {
        type: "function_call",
        call_id: "memory-call",
        name: "add_workmemory",
        arguments: jsonArguments
      },
      {
        type: "function_call_output",
        call_id: "memory-call",
        output: jsonResult
      }
    ]
  };
  const responsesResponse = {
    payload: {
      output: [{
        type: "function_call",
        call_id: "memory-call",
        name: "add_workmemory",
        arguments: jsonArguments
      }]
    }
  };

  return [
    {
      label: "OpenAI Responses",
      action: "responses.complete",
      request: responsesRequest,
      response: responsesResponse
    },
    {
      label: "Codex Responses",
      action: "codex.complete",
      request: responsesRequest,
      response: responsesResponse
    },
    {
      label: "OpenAI Chat Completions",
      action: "chat.completions.complete",
      request: {
        tools: [],
        messages: [
          {
            role: "assistant",
            tool_calls: [{
              id: "memory-call",
              type: "function",
              function: { name: "add_workmemory", arguments: jsonArguments }
            }]
          },
          {
            role: "tool",
            tool_call_id: "memory-call",
            content: jsonResult
          }
        ]
      },
      response: {
        payload: {
          choices: [{
            message: {
              tool_calls: [{
                id: "memory-call",
                type: "function",
                function: { name: "add_workmemory", arguments: jsonArguments }
              }]
            }
          }]
        }
      }
    },
    {
      label: "Anthropic Messages",
      action: "anthropic.messages.complete",
      request: {
        tools: [],
        messages: [
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "memory-call",
              name: "add_workmemory",
              input: callArguments
            }]
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "memory-call",
              content: jsonResult
            }]
          }
        ]
      },
      response: {
        payload: {
          content: [{
            type: "tool_use",
            id: "memory-call",
            name: "add_workmemory",
            input: callArguments
          }]
        }
      }
    },
    {
      label: "Gemini generateContent",
      action: "gemini.generate-content.complete",
      request: {
        tools: [],
        contents: [
          {
            role: "model",
            parts: [{
              functionCall: {
                id: "memory-call",
                name: "add_workmemory",
                args: callArguments
              }
            }]
          },
          {
            role: "user",
            parts: [{
              functionResponse: {
                id: "memory-call",
                name: "add_workmemory",
                response: callResult
              }
            }]
          }
        ]
      },
      response: {
        payload: {
          candidates: [{
            content: {
              parts: [{
                functionCall: {
                  id: "memory-call",
                  name: "add_workmemory",
                  args: callArguments
                }
              }]
            }
          }]
        }
      }
    }
  ];
}
