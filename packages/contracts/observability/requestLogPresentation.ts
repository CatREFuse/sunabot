export const requestLogBusinessNodes = [
  "all",
  "onebot_heartbeat",
  "private_conversation",
  "group_conversation",
  "memory_compression",
  "memory_recording",
  "dream"
] as const;

export type RequestLogBusinessNode = typeof requestLogBusinessNodes[number];

export const requestLogMemoryTools = [
  "all",
  "working_memory",
  "air",
  "user_profile"
] as const;

export type RequestLogMemoryTool = typeof requestLogMemoryTools[number];
export type RequestLogStatus = "neutral" | "success" | "error";

export interface RequestLogPresentation {
  businessNode: Exclude<RequestLogBusinessNode, "all"> | "other";
  businessNodes: ReadonlyArray<Exclude<RequestLogBusinessNode, "all">>;
  memoryTool?: Exclude<RequestLogMemoryTool, "all">;
  status: RequestLogStatus;
  attempt: number;
  maxAttempts: number;
  retryCount: number;
  willRetry: boolean;
}

type JsonObject = Record<string, unknown>;

const memoryToolByAction = {
  add_workmemory: "working_memory",
  read_air: "air",
  add_user_profile: "user_profile"
} as const;

export function normalizeRequestLogBusinessNode(value: unknown): RequestLogBusinessNode {
  return requestLogBusinessNodes.includes(value as RequestLogBusinessNode)
    ? value as RequestLogBusinessNode
    : "all";
}

export function normalizeRequestLogMemoryTool(value: unknown): RequestLogMemoryTool {
  return requestLogMemoryTools.includes(value as RequestLogMemoryTool)
    ? value as RequestLogMemoryTool
    : "all";
}

export function requestLogPresentation(record: Record<string, unknown>): RequestLogPresentation {
  const category = stringValue(record.category);
  const action = stringValue(record.action);
  const request = objectValue(record.request);
  const response = objectValue(record.response);
  const metadata = objectValue(record.metadata);
  const conversationId = stringValue(metadata.conversationId);
  const promptFamily = stringValue(metadata.promptFamily);
  const stage = stringValue(metadata.stage);
  const memoryTool = category === "tool.call"
    ? memoryToolByAction[action as keyof typeof memoryToolByAction]
    : undefined;
  const dream = action.startsWith("dream.")
    || promptFamily === "memory.dream"
    || conversationId.startsWith("dream:");
  const memoryRecording = memoryTool != null;
  const memoryCompression = !dream
    && !memoryRecording
    && (
      stage === "memory"
      || stringValue(metadata.memoryKind) !== ""
      || (promptFamily.startsWith("memory.") && promptFamily !== "memory.dream")
    );
  const conversationScope = stringValue(request.scope);
  const groupConversation = conversationId.includes(":group:")
    || conversationId.startsWith("group:")
    || conversationScope === "group"
    || promptFamily.includes("group")
    || stage === "orchestrator";
  const privateConversation = conversationId.includes(":private:")
    || conversationId.startsWith("private:")
    || conversationId.startsWith("web:")
    || conversationScope === "private"
    || promptFamily.includes("private");
  const businessNodes: Array<Exclude<RequestLogBusinessNode, "all">> = [];
  if (privateConversation) businessNodes.push("private_conversation");
  if (groupConversation) businessNodes.push("group_conversation");
  if (memoryCompression) businessNodes.push("memory_compression");
  if (memoryRecording) businessNodes.push("memory_recording");
  if (dream) businessNodes.push("dream");

  const attempt = positiveInteger(
    metadata.transportAttempt
    ?? metadata.attempt
    ?? metadata.attemptCount
    ?? response.attemptCount,
    1
  );
  const maxAttempts = Math.max(
    attempt,
    positiveInteger(
      metadata.maxTransportAttempts
      ?? metadata.maxAttempts
      ?? response.maxAttempts,
      attempt
    )
  );
  const status = requestLogStatus(category, action, response, objectValue(record));

  return {
    businessNode: primaryBusinessNode(businessNodes),
    businessNodes,
    ...(memoryTool ? { memoryTool } : {}),
    status,
    attempt,
    maxAttempts,
    retryCount: Math.max(0, attempt - 1),
    willRetry: response.willRetry === true
  };
}

function primaryBusinessNode(nodes: RequestLogPresentation["businessNodes"]): RequestLogPresentation["businessNode"] {
  for (const node of ["dream", "memory_recording", "memory_compression", "group_conversation", "private_conversation"] as const) {
    if (nodes.includes(node)) return node;
  }
  return "other";
}

function requestLogStatus(
  category: string,
  action: string,
  response: JsonObject,
  record: JsonObject
): RequestLogStatus {
  const statusCode = Number(response.status ?? 0);
  if (
    category === "runtime.error"
    || stringValue(record.level) === "error"
    || /\.(?:failed|error)$/u.test(action)
    || response.ok === false
    || statusCode >= 400
  ) return "error";
  if (category === "model.response" || response.ok === true || /\.(?:sent|completed|success)$/u.test(action)) {
    return "success";
  }
  return "neutral";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
