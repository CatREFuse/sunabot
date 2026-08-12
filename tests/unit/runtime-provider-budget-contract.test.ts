// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../../packages/contracts/admin/public.js";
import { probeProviderMultimodal } from "../../adapters/model/providerDiscovery.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import { SessionCoordinator } from "../../services/sessions/sessionCoordinator.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import { WORKSPACE_BASH_AUDIT_TIMEOUT_MS } from "../../services/tools/bashAuditDeadline.js";
import {
  auxiliaryModelSignal,
  auxiliaryProviderCompleteOptions
} from "../../src/runtime/auxiliaryModelBudget.js";
import { withAbortTimeout } from "../../src/runtime/infrastructure.js";
import {
  MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS,
  MEMORY_PROVIDER_TOTAL_TIMEOUT_MS
} from "../../src/runtime/memoryProviderBudget.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("auxiliary model response budget", () => {
  it("assigns one exact 10-minute signal to an auxiliary Provider request", () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const options = auxiliaryProviderCompleteOptions({
      modelRequestMaxRetries: 3,
      logContext: { stage: "test" }
    });

    expect(options.modelRequestMaxRetries).toBe(3);
    expect(options.modelRequestAttemptTimeoutMs).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
    expect(options.signal?.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledWith(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);

    controller.abort(new DOMException("timed out", "TimeoutError"));
    expect(options.signal?.aborted).toBe(true);
  });

  it("still honors explicit caller cancellation", () => {
    const controller = new AbortController();
    const signal = auxiliaryModelSignal(controller.signal);
    const reason = new Error("caller cancelled");

    controller.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("passes the shared budget and caller cancellation to multimodal model probing", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const complete = vi.fn(async (
      _system: string,
      _messages: Array<{ role: "user"; content: string; imageUrls: string[] }>,
      options: { signal?: AbortSignal; modelRequestAttemptTimeoutMs?: number }
    ) => {
      requestSignal = options.signal;
      expect(options.modelRequestAttemptTimeoutMs).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
      return "RED";
    });

    await expect(probeProviderMultimodal(
      providerConfig(),
      complete,
      caller.signal
    )).resolves.toEqual({ multimodal: true });

    expect(requestSignal?.aborted).toBe(false);
    caller.abort(new DOMException("cancelled", "AbortError"));
    expect(requestSignal?.aborted).toBe(true);
  });

  it("uses the same 10-minute contract for memory and Bash audit", () => {
    expect(MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
    expect(MEMORY_PROVIDER_TOTAL_TIMEOUT_MS).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
    expect(WORKSPACE_BASH_AUDIT_TIMEOUT_MS).toBe(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS);
  });

  it.each(["tool_completion", "scheduled_callback_delivery"])(
    "keeps the %s actor alive while its 10-minute task deadline settles",
    async (kind) => {
      vi.useFakeTimers();
      const store = new SessionStore({ databasePath: ":memory:" });
      let actorSignal: AbortSignal | undefined;
      let taskSignal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let markFinished!: () => void;
      const finished = new Promise<void>((resolve) => {
        markFinished = resolve;
      });
      const coordinator = new SessionCoordinator({
        store,
        handleEvent: async (_event, context) => {
          actorSignal = context.signal;
          try {
            return await withAbortTimeout(async (signal) => {
              taskSignal = signal;
              markStarted();
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
              return { status: "no_reply" as const };
            }, AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS, undefined, context.signal);
          } finally {
            markFinished();
          }
        },
        deliverOutbox: vi.fn(),
        codexRunner: { run: vi.fn() } as unknown as CodexRunner,
        codexSettings: () => ({
          enabled: true,
          model: "test",
          timeoutMs: 1,
          maxConcurrency: 1,
          workspacePath: process.cwd(),
          jobRoot: process.cwd()
        }),
        turnTimeoutMs: 1
      });
      try {
        coordinator.enqueueEvent({
          sessionId: `private:${kind}`,
          kind,
          payload: { type: kind }
        });
        coordinator.resume();
        await started;

        await vi.advanceTimersByTimeAsync(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS - 1);
        expect(actorSignal?.aborted).toBe(false);
        expect(taskSignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await finished;
        expect(taskSignal?.aborted).toBe(true);
        expect(actorSignal?.aborted).toBe(false);
      } finally {
        coordinator.stop();
        store.close();
      }
    }
  );

  it.each([
    ["src/runtime/tone.ts", "auxiliaryProviderCompleteOptions"],
    ["src/runtime/imageAltText.ts", "auxiliaryProviderCompleteOptions"],
    ["src/runtime/lifecycle.ts", "auxiliaryProviderCompleteOptions"],
    ["src/runtime/dreamRuntime.ts", "auxiliaryProviderCompleteOptions"],
    ["src/runtime/director.ts", "auxiliaryProviderCompleteOptions"],
    ["src/runtime/selfie.ts", "auxiliaryProviderCompleteOptions"],
    ["src/runtime/air.ts", "auxiliaryModelSignal"],
    ["src/runtime/orchestration.ts", "auxiliaryModelSignal"],
    ["src/admin/configDoctor.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["apps/api/server.ts", "auxiliaryProviderCompleteOptions"],
    ["apps/api/bashAuditRuntime.ts", "auxiliaryProviderCompleteOptions"],
    ["adapters/model/provider/imageGeneration.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["services/sessions/sessionCoordinator.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["services/webChat/webChatService.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["adapters/voice/openAiSpeechClient.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["apps/api/plugins/voiceProfileRoutes.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["src/runtime/intake.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"],
    ["src/runtime/runtimeContracts.ts", "AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS"]
  ])("keeps a source-level wiring smoke for %s", async (file, marker) => {
    const source = await fs.readFile(path.resolve(process.cwd(), file), "utf8");
    expect(source).toContain(marker);
  });
});

function providerConfig(): ProviderConfig {
  return {
    id: "vision-probe",
    label: "Vision Probe",
    kind: "openai-compatible",
    enabled: true,
    model: "vision-model",
    baseUrl: "https://provider.example/v1",
    apiKeyEnv: "VISION_PROBE_API_KEY",
    temperature: 0,
    maxOutputTokens: 32,
    modelSource: "custom",
    multimodal: "auto"
  };
}
