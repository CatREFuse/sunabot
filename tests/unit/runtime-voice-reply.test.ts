// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { ProviderVoiceCompanion } from "../../adapters/model/openaiProvider.js";
import type { ReplyDelivery } from "../../src/runtime/runtimeContracts.js";
import {
  sendRuntimeVoiceFinalReply,
  startRuntimeDeferredVoiceSynthesis,
  startRuntimeVoiceSynthesis,
} from "../../src/runtime/voiceReply.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("runtime voice reply", () => {
  it.each(["text", "voice"] as const)(
    "lets %s enqueue first when it becomes ready first",
    async (first) => {
      const text = deferred<void>();
      const voice = deferred<void>();
      const events: string[] = [];
      const host = runtimeHost({
        sendAssistantReply: vi.fn(async () => {
          events.push("text:start");
          await text.promise;
          events.push("text:enqueued");
          return undefined;
        }),
        synthesizeAndQueueVoice: vi.fn(async () => {
          events.push("voice:start");
          await voice.promise;
          events.push("voice:enqueued");
          return { ok: true as const };
        }),
      });

      const operation = sendRuntimeVoiceFinalReply(host, finalReplyInput());
      await vi.waitFor(() =>
        expect(events).toEqual(["voice:start", "text:start"]),
      );
      (first === "text" ? text : voice).resolve();
      await vi.waitFor(() => expect(events).toContain(`${first}:enqueued`));
      expect(events).not.toContain(
        `${first === "text" ? "voice" : "text"}:enqueued`,
      );
      (first === "text" ? voice : text).resolve();
      await expect(operation).resolves.toBe(false);
    },
  );

  it("keeps voice synthesis alive when text preparation fails", async () => {
    const voice = deferred<void>();
    const voiceFinished = vi.fn();
    const host = runtimeHost({
      sendAssistantReply: vi.fn(async () => {
        throw new Error("text failed");
      }),
      synthesizeAndQueueVoice: vi.fn(async () => {
        await voice.promise;
        voiceFinished();
        return { ok: true as const };
      }),
    });

    const operation = sendRuntimeVoiceFinalReply(host, finalReplyInput());
    await Promise.resolve();
    expect(voiceFinished).not.toHaveBeenCalled();
    voice.resolve();
    await expect(operation).rejects.toThrow("text failed");
    expect(voiceFinished).toHaveBeenCalledOnce();
  });

  it("does not expose a voice task without durable delivery", () => {
    const synthesizeAndQueueVoice = vi.fn();
    const host = runtimeHost({ synthesizeAndQueueVoice });

    expect(
      startRuntimeVoiceSynthesis(host, companion(), {
        incoming: incoming(),
        gateway: gateway(),
        logRunId: "voice-run",
      }),
    ).toBeUndefined();
    expect(synthesizeAndQueueVoice).not.toHaveBeenCalled();
  });

  it("routes deferred voice through the post-defer outbox callback", async () => {
    const emitOutbox = vi.fn(async () => undefined);
    const emitDeferredOutbox = vi.fn(async () => undefined);
    const synthesizeAndQueueVoice = vi.fn(async (_voice, context) => {
      await context.delivery.emitOutbox({ kind: "deferred-voice" } as never);
      return { ok: true as const };
    });
    const host = runtimeHost({ synthesizeAndQueueVoice });

    await startRuntimeDeferredVoiceSynthesis(host, companion(), {
      incoming: incoming(),
      gateway: gateway(),
      logRunId: "voice-run",
      delivery: { outbox: [], emitOutbox, emitDeferredOutbox },
    });

    expect(emitDeferredOutbox).toHaveBeenCalledOnce();
    expect(emitOutbox).not.toHaveBeenCalled();
  });
});

function runtimeHost(overrides: Partial<SunaRuntime> = {}) {
  return {
    config: createAdminTestConfig("/tmp/sunabot-runtime-voice-reply"),
    sendAssistantReply: vi.fn(async () => undefined),
    synthesizeAndQueueVoice: vi.fn(async () => ({ ok: true as const })),
    scheduleMemoryCompression: vi.fn(),
    ...overrides,
  } as unknown as SunaRuntime;
}

function finalReplyInput() {
  const delivery: ReplyDelivery = {
    outbox: [],
    emitOutbox: vi.fn(async () => undefined),
  };
  return {
    channelKey: "private:2002",
    incoming: incoming(),
    gateway: gateway(),
    text: "おやすみなさい。",
    isAdmin: true,
    generatedImages: [],
    logRunId: "voice-run",
    delivery,
    messageOrigin: "text" as const,
    toolNames: ["send_voice_message"],
    voice: companion(),
  };
}

function companion(): ProviderVoiceCompanion {
  return {
    text: "おやすみなさい。",
    language: "ja",
    callId: "voice-call",
    toolName: "send_voice_message",
  };
}

function incoming(): ParsedIncomingMessage {
  return {
    scope: "private",
    transport: "onebot",
    userId: 2002,
    text: "晚安",
    images: [],
    attachments: [],
    quoteReferences: [],
    sender: { id: "2002" },
  };
}

function gateway() {
  return {
    getStatus: () => ({ connected: true, connections: 1, selfIds: ["4004"] }),
  } as MessagingPort;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve: () => resolve(undefined as T) };
}
