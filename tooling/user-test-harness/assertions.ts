import type {
  HarnessAssertion,
  HarnessToolCallObservation,
  UserTestCase,
  UserTestExpectedOutput
} from "./contracts.js";

export function evaluateHarnessAssertions(input: {
  expected: UserTestExpectedOutput;
  toolCalls: readonly HarnessToolCallObservation[];
  outbound: readonly unknown[];
  inboundAttachments?: readonly Record<string, unknown>[];
  requestLogs?: readonly unknown[];
  textValues?: readonly unknown[];
}) {
  const assertions: HarnessAssertion[] = [];
  const text = collectText(input.textValues ?? input.outbound);
  const availableTools = extractProviderToolCatalog(input.requestLogs ?? []);
  for (const tool of input.expected.requiredTools ?? []) {
    const calls = input.toolCalls.filter((call) => call.name === tool);
    assertions.push({
      id: `tool.required:${tool}`,
      passed: calls.some((call) => call.status === "succeeded"),
      expected: `${tool} succeeded`,
      actual: calls.map((call) => call.status)
    });
  }
  for (const tool of input.expected.forbiddenTools ?? []) {
    const calls = input.toolCalls.filter((call) => call.name === tool);
    assertions.push({
      id: `tool.forbidden:${tool}`,
      passed: calls.length === 0,
      expected: `not ${tool}`,
      actual: calls.map((call) => call.status)
    });
  }
  for (const tool of input.expected.forbiddenSuccessfulTools ?? []) {
    const calls = input.toolCalls.filter((call) => call.name === tool);
    assertions.push({
      id: `tool.forbidden_success:${tool}`,
      passed: calls.every((call) => call.status !== "succeeded"),
      expected: `${tool} did not succeed`,
      actual: calls.map((call) => call.status)
    });
  }
  for (const tool of input.expected.requiredAvailableTools ?? []) {
    assertions.push({
      id: `tool.available:${tool}`,
      passed: availableTools.includes(tool),
      expected: `${tool} present in Provider tool catalog`,
      actual: availableTools
    });
  }
  for (const tool of input.expected.forbiddenAvailableTools ?? []) {
    assertions.push({
      id: `tool.unavailable:${tool}`,
      passed: !availableTools.includes(tool),
      expected: `${tool} absent from Provider tool catalog`,
      actual: availableTools
    });
  }
  for (const value of input.expected.requiredText ?? []) {
    assertions.push({
      id: `text.required:${digestLabel(value)}`,
      passed: text.includes(value),
      expected: value,
      actual: text
    });
  }
  for (const value of input.expected.forbiddenText ?? []) {
    assertions.push({
      id: `text.forbidden:${digestLabel(value)}`,
      passed: !text.includes(value),
      expected: `not ${value}`,
      actual: text
    });
  }
  if (input.expected.providerPrompt) {
    assertions.push(...evaluateProviderPromptAssertions(
      input.expected.providerPrompt,
      input.requestLogs ?? []
    ));
  }
  const outboundKinds = input.outbound
    .map((value) => asRecord(value)?.kind)
    .filter((value): value is string => typeof value === "string");
  for (const kind of input.expected.requiredOutboundKinds ?? []) {
    assertions.push({
      id: `outbound.required_kind:${kind}`,
      passed: outboundKinds.includes(kind),
      expected: `${kind} outbound`,
      actual: outboundKinds
    });
  }
  for (const kind of input.expected.forbiddenOutboundKinds ?? []) {
    assertions.push({
      id: `outbound.forbidden_kind:${kind}`,
      passed: !outboundKinds.includes(kind),
      expected: `no ${kind} outbound`,
      actual: outboundKinds
    });
  }
  for (const expected of input.expected.requiredInboundAttachments ?? []) {
    const actual = input.inboundAttachments?.find((attachment) => (
      attachment.messageId === expected.messageId &&
      attachment.index === expected.index
    ));
    const fields = Object.entries(expected);
    assertions.push({
      id: `attachment.required:${expected.messageId}:${expected.index}`,
      passed: Boolean(actual) && fields.every(([key, value]) => actual?.[key] === value),
      expected,
      actual: actual ?? "missing"
    });
  }
  if (input.expected.minimumOutboundCount != null) {
    assertions.push({
      id: "outbound.minimum",
      passed: input.outbound.length >= input.expected.minimumOutboundCount,
      expected: input.expected.minimumOutboundCount,
      actual: input.outbound.length
    });
  }
  if (input.expected.maximumOutboundCount != null) {
    assertions.push({
      id: "outbound.maximum",
      passed: input.outbound.length <= input.expected.maximumOutboundCount,
      expected: input.expected.maximumOutboundCount,
      actual: input.outbound.length
    });
  }
  return assertions;
}

function evaluateProviderPromptAssertions(
  expected: NonNullable<UserTestExpectedOutput["providerPrompt"]>,
  logs: readonly unknown[]
) {
  const requestLogs = logs
    .map(asRecord)
    .filter((log) => {
      if (log?.category !== "model.request") return false;
      const metadata = asRecord(log.metadata);
      return metadata?.promptFamily === expected.promptFamily && metadata.round === 0;
    })
    .sort(compareProviderRequestOrder);
  const evidence = requestLogs.map((requestLog, index) => {
    const requestText = collectText([requestLog.request]);
    const orderedOccurrences = expected.orderedText.map((value) => ({
      value,
      count: literalOccurrenceCount(requestText, value),
      index: requestText.indexOf(value)
    }));
    return {
      transportAttempt: positiveFiniteNumber(asRecord(requestLog.metadata)?.transportAttempt) ===
          Number.MAX_SAFE_INTEGER
        ? index + 1
        : positiveFiniteNumber(asRecord(requestLog.metadata)?.transportAttempt),
      orderedOccurrences,
      exactOnce: orderedOccurrences.every((item) => item.count === 1),
      inOrder: orderedOccurrences.every((item, itemIndex) => (
        itemIndex === 0 || item.index > orderedOccurrences[itemIndex - 1]!.index
      )),
      forbiddenOccurrences: (expected.forbiddenText ?? []).map((value) => ({
        value,
        count: literalOccurrenceCount(requestText, value)
      }))
    };
  });
  return [
    {
      id: `provider_prompt.request:${expected.promptFamily}`,
      passed: requestLogs.length > 0,
      expected: {
        promptFamily: expected.promptFamily,
        round: 0,
        transportAttempts: "all"
      },
      actual: {
        promptFamily: expected.promptFamily,
        round: 0,
        transportAttempts: evidence.map((item) => item.transportAttempt)
      }
    },
    {
      id: `provider_prompt.ordered:${expected.promptFamily}`,
      passed: evidence.length > 0 && evidence.every((item) => item.exactOnce && item.inOrder),
      expected: {
        orderedText: expected.orderedText,
        occurrenceCountPerTransportAttempt: 1
      },
      actual: evidence.map((item) => ({
        transportAttempt: item.transportAttempt,
        counts: item.orderedOccurrences.map(({ value, count }) => ({ value, count })),
        inOrder: item.inOrder
      }))
    },
    {
      id: `provider_prompt.forbidden:${expected.promptFamily}`,
      passed: evidence.length > 0 && evidence.every((item) => (
        item.forbiddenOccurrences.every((occurrence) => occurrence.count === 0)
      )),
      expected: {
        forbiddenText: expected.forbiddenText ?? [],
        occurrenceCountPerTransportAttempt: 0
      },
      actual: evidence.map((item) => ({
        transportAttempt: item.transportAttempt,
        occurrences: item.forbiddenOccurrences
      }))
    }
  ];
}

function compareProviderRequestOrder(
  left: Record<string, unknown>,
  right: Record<string, unknown>
) {
  const leftMetadata = asRecord(left.metadata);
  const rightMetadata = asRecord(right.metadata);
  const leftAttempt = positiveFiniteNumber(leftMetadata?.transportAttempt);
  const rightAttempt = positiveFiniteNumber(rightMetadata?.transportAttempt);
  if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
  const leftAt = Date.parse(String(left.at ?? ""));
  const rightAt = Date.parse(String(right.at ?? ""));
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt)) return leftAt - rightAt;
  return 0;
}

export function extractConversationUserFacingTextValues(outbound: readonly unknown[]) {
  return outbound.flatMap((item) => {
    const observation = asRecord(item);
    const value = asRecord(observation?.value);
    if (observation?.kind === "message") {
      const segments = Array.isArray(value?.contentSegments)
        ? value.contentSegments.flatMap((segment) => {
          const record = asRecord(segment);
          return record?.type === "text" && typeof record.text === "string"
            ? [record.text]
            : [];
        })
        : [];
      return [
        ...(typeof value?.text === "string" ? [value.text] : []),
        ...segments
      ];
    }
    if (observation?.kind === "asset") {
      const asset = asRecord(value?.asset);
      return typeof asset?.name === "string" ? [asset.name] : [];
    }
    return [];
  });
}

export function validateConversationActor(
  testCase: UserTestCase,
  administratorQq: string
): HarnessAssertion[] {
  if (testCase.kind !== "conversation") return [];
  const input = testCase.input as Extract<UserTestCase["input"], { actor: string }>;
  const event = input.event;
  const privateActor = input.actor.endsWith("_private");
  const adminActor = input.actor.startsWith("admin_");
  const userId = String(event.user_id ?? "");
  const groupId = event.group_id;
  return [
    {
      id: "actor.self_identity",
      passed: String(event.self_id ?? "") === input.selfId,
      expected: input.selfId,
      actual: String(event.self_id ?? "")
    },
    {
      id: "actor.scope",
      passed: privateActor
        ? event.message_type === "private" && groupId == null
        : event.message_type === "group" && Number.isSafeInteger(Number(groupId)),
      expected: input.actor,
      actual: { message_type: event.message_type, group_id: groupId }
    },
    {
      id: "actor.authority",
      passed: adminActor
        ? Boolean(administratorQq) && userId === administratorQq
        : Boolean(userId) && userId !== administratorQq,
      expected: adminActor ? "administrator" : "non-administrator",
      actual: userId === administratorQq ? "administrator" : "non-administrator"
    }
  ];
}

export function extractCalledToolNames(logs: readonly unknown[]) {
  return [...new Set(extractToolCallObservations(logs).map((call) => call.name))];
}

export function extractProviderToolCatalog(logs: readonly unknown[]) {
  return [...new Set(logs.flatMap((value) => {
    const log = asRecord(value);
    if (log?.category !== "model.request") return [];
    const request = asRecord(log.request);
    const body = asRecord(request?.body);
    const tools = Array.isArray(request?.tools)
      ? request.tools
      : Array.isArray(body?.tools)
        ? body.tools
        : [];
    return tools.flatMap((tool) => {
      const record = asRecord(tool);
      const fn = asRecord(record?.function);
      const name = typeof record?.name === "string"
        ? record.name.trim()
        : typeof fn?.name === "string"
          ? fn.name.trim()
          : "";
      return name ? [name] : [];
    });
  }))].sort();
}

export function extractToolCallObservations(
  logs: readonly unknown[]
): HarnessToolCallObservation[] {
  return logs.flatMap((value) => {
    const log = asRecord(value);
    const name = typeof log?.action === "string" ? log.action.trim() : "";
    if (log?.category !== "tool.call" || !name) return [];
    const request = asRecord(log.request);
    const metadata = asRecord(log.metadata);
    return [{
      name,
      ...(typeof request?.callId === "string" && request.callId.trim()
        ? { callId: request.callId.trim() }
        : {}),
      ...(typeof metadata?.stage === "string" && metadata.stage.trim()
        ? { stage: metadata.stage.trim() }
        : {}),
      status: toolCallStatus(log.response),
      ...(log.request === undefined ? {} : { request: log.request }),
      ...(log.response === undefined ? {} : { response: log.response })
    }];
  });
}

export function evaluateProviderEvidence(logs: readonly unknown[]): HarnessAssertion[] {
  const responses = logs
    .map(asRecord)
    .filter((log): log is Record<string, unknown> => log?.category === "model.response");
  const terminalFailures = responses.filter((log) => {
    const response = asRecord(log.response);
    return response?.ok === false && response.willRetry !== true;
  });
  const runtimeFailures = logs
    .map(asRecord)
    .filter((log): log is Record<string, unknown> => (
      log?.category === "runtime.action" &&
      typeof log.action === "string" &&
      /(?:^|[.:])failed$/u.test(log.action)
    ));
  return [
    {
      id: "provider.successful_response",
      passed: responses.some((log) => asRecord(log.response)?.ok === true),
      expected: "at least one successful model response",
      actual: `${responses.length} model response log(s)`
    },
    {
      id: "provider.terminal_failures",
      passed: terminalFailures.length === 0 && runtimeFailures.length === 0,
      expected: "no terminal Provider or Runtime failure",
      actual: {
        terminalModelFailures: terminalFailures.length,
        runtimeFailures: runtimeFailures.map((log) => log.action)
      }
    }
  ];
}

function collectText(values: readonly unknown[]) {
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  values.forEach(visit);
  return strings.join("\n");
}

function literalOccurrenceCount(text: string, value: string) {
  let count = 0;
  let from = 0;
  while (from <= text.length - value.length) {
    const index = text.indexOf(value, from);
    if (index < 0) break;
    count += 1;
    from = index + value.length;
  }
  return count;
}

function positiveFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Number.MAX_SAFE_INTEGER;
}

function digestLabel(value: string) {
  return value.replace(/\s+/gu, " ").slice(0, 32);
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolCallStatus(value: unknown): HarnessToolCallObservation["status"] {
  const response = asRecord(value);
  if (!response) return value === undefined ? "unknown" : "succeeded";
  if (response.ok === false || response.isError === true || typeof response.error === "string") {
    return "failed";
  }
  if (response.ok === true || response.isError === false) return "succeeded";
  const status = typeof response.status === "string" ? response.status.trim().toLowerCase() : "";
  if (["failed", "error", "rejected", "denied", "unavailable", "cancelled"].includes(status)) {
    return "failed";
  }
  if (["running", "queued", "pending", "accepted", "deferred"].includes(status)) {
    return "pending";
  }
  return "succeeded";
}
