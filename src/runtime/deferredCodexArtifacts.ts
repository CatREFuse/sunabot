import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FrozenCodexInputV1 } from "../../packages/contracts/tools/codex.js";
import {
  resolveConversationWorkbench,
  type ConversationCapabilityContextV1
} from "../../services/conversations/conversationCapability.js";
import type { ChatMediaToolPort } from "../../services/tools/chatMediaTool.js";
import type { ProviderDeferredTurn } from "../../adapters/model/provider/contracts.js";

export async function snapshotDeferredCodexTask(input: {
  toolCall: ProviderDeferredTurn["toolCall"];
  capability?: Readonly<ConversationCapabilityContextV1>;
  chatMedia?: ChatMediaToolPort;
  jobRoot: string;
  isCurrent(): boolean;
}) {
  if (input.toolCall.name !== "codex") {
    return { toolCall: input.toolCall };
  }
  if (!input.capability || !input.isCurrent()) {
    throw new Error("CODEX_CONVERSATION_CAPABILITY_UNAVAILABLE");
  }
  const handles = readCodexInputHandles(input.toolCall.arguments.inputHandles);
  const backend = resolveConversationWorkbench(
    input.capability,
    "codex_artifact"
  ).primaryBackend;
  const jobId = randomUUID();
  const jobDir = path.join(input.jobRoot, jobId);
  let frozenInputs: FrozenCodexInputV1[] = [];
  if (handles.length) {
    if (!input.chatMedia?.freezeCodexInputs) {
      throw new Error("CODEX_INPUT_HANDLES_UNAVAILABLE");
    }
    frozenInputs = await input.chatMedia.freezeCodexInputs(handles, jobDir);
  }
  if (!input.isCurrent()) {
    throw new Error("CODEX_CONVERSATION_CAPABILITY_EXPIRED");
  }
  return {
    jobId,
    toolCall: {
      ...input.toolCall,
      arguments: {
        ...input.toolCall.arguments,
        __sunabot_artifact_backend: backend,
        ...(frozenInputs.length ? { __sunabot_frozen_inputs: frozenInputs } : {})
      }
    }
  };
}

export function readCodexInputHandles(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("CODEX_INPUT_HANDLES_INVALID");
  }
  const handles = value.map((item) => {
    if (
      typeof item !== "string"
      || item.length > 512
      || !/^message:[0-9]+:(?:image|file):[0-9]+$/u.test(item)
    ) {
      throw new Error("CODEX_INPUT_HANDLES_INVALID");
    }
    return item;
  });
  if (new Set(handles).size !== handles.length) {
    throw new Error("CODEX_INPUT_HANDLES_INVALID");
  }
  return handles;
}
