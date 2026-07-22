import type { ProviderVoiceCompanion } from "../../adapters/model/openaiProvider.js";
import { planAgentEmojiMarkers } from "../emojis/emojiAssets.js";
import type {
  AssistantMessageOrigin,
  ImageResult,
  ParsedIncomingMessage,
} from "../types.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { runtime_sendAssistantReply } from "./delivery.js";
import type { ReplyDelivery, RuntimeConfigPort } from "./runtimeContracts.js";
import type { SystemConfigReplyLifecycle } from "./systemConfigReply.js";
import type { RuntimeVoice } from "./voice.js";

interface RuntimeVoiceReplyHost extends RuntimeConfigPort {
  synthesizeAndQueueVoice(
    ...args: Parameters<RuntimeVoice["synthesizeAndQueue"]>
  ): ReturnType<RuntimeVoice["synthesizeAndQueue"]>;
  sendAssistantReply(
    ...args: Parameters<typeof runtime_sendAssistantReply>
  ): ReturnType<typeof runtime_sendAssistantReply>;
  scheduleMemoryCompression(
    record: NonNullable<Awaited<ReturnType<typeof runtime_sendAssistantReply>>>
  ): void;
}

interface RuntimeVoiceSynthesisInput {
  incoming: ParsedIncomingMessage;
  gateway: MessagingPort;
  logRunId: string;
  isCurrent?: () => boolean;
  delivery?: ReplyDelivery;
  signal?: AbortSignal;
}

interface RuntimeVoiceFinalReplyInput extends RuntimeVoiceSynthesisInput {
  lifecycle?: SystemConfigReplyLifecycle;
  channelKey: string;
  text: string;
  isAdmin: boolean;
  generatedImages: ImageResult[];
  messageOrigin: AssistantMessageOrigin;
  toolNames: readonly string[];
  voice: ProviderVoiceCompanion;
  textAlreadyDelivered?: boolean;
}

export function startRuntimeVoiceSynthesis(
  host: RuntimeVoiceReplyHost,
  voice: ProviderVoiceCompanion | undefined,
  input: RuntimeVoiceSynthesisInput,
) {
  if (!voice || !input.delivery) return undefined;
  return host.synthesizeAndQueueVoice(voice, {
    incoming: input.incoming,
    gateway: input.gateway,
    logRunId: input.logRunId,
    isCurrent: input.isCurrent,
    delivery: input.delivery,
    signal: input.signal,
  });
}

export function startRuntimeDeferredVoiceSynthesis(
  host: RuntimeVoiceReplyHost,
  voice: ProviderVoiceCompanion | undefined,
  input: RuntimeVoiceSynthesisInput,
) {
  const emitOutbox = input.delivery?.emitDeferredOutbox;
  if (!emitOutbox || !input.delivery) return undefined;
  return startRuntimeVoiceSynthesis(host, voice, {
    ...input,
    delivery: { ...input.delivery, emitOutbox },
  });
}

export async function sendRuntimeVoiceFinalReply(
  host: RuntimeVoiceReplyHost,
  input: RuntimeVoiceFinalReplyInput,
) {
  const emojiPlan = planAgentEmojiMarkers(input.text, host.config);
  const prepared = input.lifecycle?.prepareFinalDelivery({
    delivery: input.delivery,
    generatedImages: [...input.generatedImages, ...emojiPlan.expectedImages],
    messageOrigin: input.messageOrigin,
    toolNames: input.toolNames,
  });
  if (prepared?.timing === "immediate") {
    input.lifecycle?.discard();
    throw new Error(
      "send_voice_message cannot accompany a system_config mutation.",
    );
  }
  const delivery = prepared?.delivery ?? input.delivery;
  const voiceSynthesis = startRuntimeVoiceSynthesis(host, input.voice, {
    incoming: input.incoming,
    gateway: input.gateway,
    logRunId: input.logRunId,
    isCurrent: input.isCurrent,
    delivery,
    signal: input.signal,
  });
  const textDelivery = input.textAlreadyDelivered
    ? Promise.resolve(undefined)
    : host.sendAssistantReply(
        input.channelKey,
        input.incoming,
        input.gateway,
        input.text,
        input.isAdmin,
        input.generatedImages,
        input.logRunId,
        input.isCurrent,
        delivery,
        true,
        { messageOrigin: input.messageOrigin, toolNames: [...input.toolNames] },
        "immediate",
        input.signal,
        emojiPlan,
      );
  const [textResult] = await Promise.allSettled([textDelivery, voiceSynthesis]);
  if (textResult.status === "rejected") {
    input.lifecycle?.discard();
    throw textResult.reason;
  }
  await input.lifecycle?.commitAndRelease();
  if (input.delivery) input.delivery.terminalStatus = "replied";
  if (textResult.value) host.scheduleMemoryCompression(textResult.value);
  return Boolean(textResult.value);
}
