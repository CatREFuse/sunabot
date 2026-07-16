// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { assistantReplyEnvelope } from "../../packages/contracts/session/runtimeMessages.js";
import type {
  SystemConfigMutationDescriptor,
  SystemConfigTurn
} from "../../services/tools/systemConfigTool.js";
import {
  SystemConfigReplyLifecycle,
  systemConfigMutationFingerprint
} from "../../src/runtime/systemConfigReply.js";
import type {
  ReplyDelivery,
  ReplyDeliveryDraft,
  SystemConfigHeldConfirmationHandle
} from "../../src/runtime/runtimeContracts.js";
import { SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT } from "../../src/runtime/runtimeContracts.js";

const binding = {
  agentId: "plana",
  conversationId: "private:171419991",
  administratorUserId: 171419991
};

describe("SystemConfigReplyLifecycle", () => {
  it("requires appendHeld before committing and discards a gate-raced turn", async () => {
    const staged = stagedTurn();
    const appendHeld = vi.fn();
    const lifecycle = new SystemConfigReplyLifecycle(staged.turn, binding);
    lifecycle.prepareFinalDelivery(finalInput({
      outbox: [],
      systemConfigHeld: { appendHeld }
    }));

    await expect(lifecycle.commitAndRelease()).rejects.toThrow(
      "配置确认未进入 held 持久化队列"
    );
    expect(appendHeld).not.toHaveBeenCalled();
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
  });

  it("discards after appendHeld failure without calling the ordinary emitter", async () => {
    const staged = stagedTurn();
    const ordinaryEmit = vi.fn();
    const lifecycle = new SystemConfigReplyLifecycle(staged.turn, binding);
    const prepared = lifecycle.prepareFinalDelivery(finalInput({
      outbox: [],
      emitOutbox: ordinaryEmit,
      systemConfigHeld: {
        appendHeld: vi.fn(async () => {
          throw new Error("append failed");
        })
      }
    }));

    await expect(prepared.delivery.emitOutbox!(confirmationDraft())).rejects.toThrow("append failed");
    lifecycle.discard();

    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
    expect(ordinaryEmit).not.toHaveBeenCalled();
  });

  it("releases the original confirmation only after commit succeeds", async () => {
    const order: string[] = [];
    const staged = stagedTurn(async () => {
      order.push("commit");
    });
    const handle = heldHandle({
      release: async () => {
        order.push("release");
      }
    });
    const appendHeld = vi.fn(async () => {
      order.push("append");
      return handle;
    });
    const lifecycle = new SystemConfigReplyLifecycle(staged.turn, binding);
    const prepared = lifecycle.prepareFinalDelivery(finalInput({
      outbox: [],
      systemConfigHeld: { appendHeld }
    }));

    await prepared.delivery.emitOutbox!(confirmationDraft());
    await lifecycle.commitAndRelease();

    expect(order).toEqual(["append", "commit", "release"]);
    expect(handle.neutralizeAndRelease).not.toHaveBeenCalled();
    expect(appendHeld.mock.calls[0]?.[1]).toEqual({
      mutationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("atomically neutralizes and releases when commit fails", async () => {
    const staged = stagedTurn(async () => {
      throw new Error("revision conflict");
    });
    const handle = heldHandle();
    const lifecycle = await appendedLifecycle(staged.turn, handle);

    await expect(lifecycle.commitAndRelease()).rejects.toThrow("已释放中性通知");

    expect(handle.neutralizeAndRelease).toHaveBeenCalledOnce();
    expect(handle.release).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
    expect(SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT).toBe("设置结果未确认，请重新查询当前设置");
  });

  it("keeps the original success confirmation held when neutralizeAndRelease fails", async () => {
    const state = { holdState: "held", claimable: false };
    const staged = stagedTurn(async () => {
      throw new Error("commit failed");
    });
    const handle = heldHandle({
      neutralizeAndRelease: async () => {
        throw new Error("transaction failed");
      }
    });
    const lifecycle = await appendedLifecycle(staged.turn, handle);

    await expect(lifecycle.commitAndRelease()).rejects.toThrow("无法原子转为中性通知");

    expect(state).toEqual({ holdState: "held", claimable: false });
    expect(handle.release).not.toHaveBeenCalled();
  });

  it("never falls back to ordinary emit when release fails after commit", async () => {
    const staged = stagedTurn();
    const ordinaryEmit = vi.fn();
    const handle = heldHandle({
      release: async () => {
        throw new Error("release unavailable");
      }
    });
    const lifecycle = new SystemConfigReplyLifecycle(staged.turn, binding);
    const prepared = lifecycle.prepareFinalDelivery(finalInput({
      outbox: [],
      emitOutbox: ordinaryEmit,
      systemConfigHeld: { appendHeld: vi.fn(async () => handle) }
    }));
    await prepared.delivery.emitOutbox!(confirmationDraft());

    await expect(lifecycle.commitAndRelease()).rejects.toThrow("尚未释放");

    expect(staged.commit).toHaveBeenCalledOnce();
    expect(ordinaryEmit).not.toHaveBeenCalled();
    expect(handle.neutralizeAndRelease).not.toHaveBeenCalled();
  });

  it("discards idempotently", () => {
    const staged = stagedTurn();
    const lifecycle = new SystemConfigReplyLifecycle(staged.turn, binding);

    lifecycle.discard();
    lifecycle.discard();

    expect(staged.discard).toHaveBeenCalledOnce();
  });

  it("does not execute an orphaned held mutation and allows recovery to release a neutral notice", async () => {
    const staged = stagedTurn();
    let held = true;
    const handle = heldHandle({
      neutralizeAndRelease: async () => {
        held = false;
      }
    });
    const lifecycle = await appendedLifecycle(staged.turn, handle);

    expect(staged.commit).not.toHaveBeenCalled();
    expect(held).toBe(true);

    await handle.neutralizeAndRelease();

    expect(held).toBe(false);
    expect(staged.commit).not.toHaveBeenCalled();
    expect(lifecycle).toBeDefined();
  });

  it("produces stable fingerprints and changes them for another normalized mutation", () => {
    const descriptor = privateGateDescriptor();
    const retry = systemConfigMutationFingerprint(binding, structuredClone(descriptor));
    const changed = systemConfigMutationFingerprint(binding, {
      ...descriptor,
      normalizedInput: { ...descriptor.normalizedInput, enabled: true },
      closesCurrentPrivateReplyGate: false
    });
    const anotherAdmin = systemConfigMutationFingerprint({
      ...binding,
      administratorUserId: 171419992
    }, descriptor);
    const anotherAgent = systemConfigMutationFingerprint({
      ...binding,
      agentId: "arona"
    }, descriptor);
    const anotherConversation = systemConfigMutationFingerprint({
      ...binding,
      conversationId: "private:171419992"
    }, descriptor);
    const anotherAction = systemConfigMutationFingerprint(binding, {
      action: "set_orchestrator",
      normalizedInput: {
        ...descriptor.normalizedInput,
        operation: "set_orchestrator",
        replyScope: null,
        enabled: true
      },
      closesCurrentPrivateReplyGate: false
    });

    expect(systemConfigMutationFingerprint(binding, descriptor)).toBe(retry);
    expect(changed).not.toBe(retry);
    expect(anotherAdmin).not.toBe(retry);
    expect(anotherAgent).not.toBe(retry);
    expect(anotherConversation).not.toBe(retry);
    expect(anotherAction).not.toBe(retry);
    expect(retry).not.toContain(binding.agentId);
    expect(retry).not.toContain(binding.conversationId);
  });

  it("allows an identical held retry and fails closed on a fingerprint mismatch", async () => {
    let storedFingerprint: string | undefined;
    const handle = heldHandle();
    const appendHeld = vi.fn(async (
      _draft: ReplyDeliveryDraft,
      options: { mutationFingerprint: string }
    ) => {
      if (storedFingerprint && storedFingerprint !== options.mutationFingerprint) {
        throw new Error("mutation fingerprint mismatch");
      }
      storedFingerprint = options.mutationFingerprint;
      return handle;
    });
    const port = { appendHeld };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = new SystemConfigReplyLifecycle(stagedTurn().turn, binding);
      const prepared = retry.prepareFinalDelivery(finalInput({ outbox: [], systemConfigHeld: port }));
      await expect(prepared.delivery.emitOutbox!(confirmationDraft())).resolves.toBeUndefined();
    }

    const changed = new SystemConfigReplyLifecycle(stagedTurn().turn, {
      ...binding,
      conversationId: "private:171419992"
    });
    const prepared = changed.prepareFinalDelivery(finalInput({ outbox: [], systemConfigHeld: port }));
    await expect(prepared.delivery.emitOutbox!(confirmationDraft()))
      .rejects.toThrow("mutation fingerprint mismatch");
    changed.discard();

    expect(appendHeld).toHaveBeenCalledTimes(3);
    expect(new Set(appendHeld.mock.calls.slice(0, 2).map((call) => call[1].mutationFingerprint)).size).toBe(1);
  });

  it("supports idempotent release retry after the first response is lost", async () => {
    let deliveryCount = 0;
    let released = false;
    const release = vi.fn(async () => {
      if (!released) {
        released = true;
        deliveryCount += 1;
        throw new Error("response lost");
      }
    });
    const handle = heldHandle({ release });

    await expect(handle.release()).rejects.toThrow("response lost");
    await expect(handle.release()).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(2);
    expect(deliveryCount).toBe(1);
  });
});

async function appendedLifecycle(
  turn: SystemConfigTurn,
  handle: SystemConfigHeldConfirmationHandle
) {
  const lifecycle = new SystemConfigReplyLifecycle(turn, binding);
  const prepared = lifecycle.prepareFinalDelivery(finalInput({
    outbox: [],
    systemConfigHeld: { appendHeld: vi.fn(async () => handle) }
  }));
  await prepared.delivery.emitOutbox!(confirmationDraft());
  return lifecycle;
}

function finalInput(delivery: ReplyDelivery) {
  return {
    delivery,
    generatedImages: [],
    messageOrigin: "text" as const,
    toolNames: ["system_config"]
  };
}

function confirmationDraft(): ReplyDeliveryDraft {
  return {
    kind: "onebot.reply",
    payload: assistantReplyEnvelope({
      type: "assistant_reply",
      incoming: {
        schemaVersion: 1,
        scope: "private",
        userId: 171419991,
        time: "2026-07-17T00:00:00.000Z",
        sender: { id: "171419991" },
        text: "关闭私聊自动回复",
        media: [],
        attachments: [],
        replyMessageIds: [],
        quoteReferences: [],
        mentionedSelf: true
      },
      text: "私聊自动回复已关闭。",
      generatedImages: [],
      isAdmin: true,
      messageOrigin: "text",
      toolNames: ["system_config"]
    }, {
      conversationId: "private:171419991",
      correlationId: "run-1"
    })
  };
}

function stagedTurn(commitEffect: () => Promise<void> = async () => undefined) {
  let staged = true;
  let rejected = false;
  const commit = vi.fn(async () => {
    await commitEffect();
    staged = false;
  });
  const discard = vi.fn(() => {
    staged = false;
  });
  const turn: SystemConfigTurn = {
    execute: vi.fn(async () => ({ ok: true })),
    mutationStaged: () => staged,
    stagedMutation: () => staged ? privateGateDescriptor() : undefined,
    rejectTurn: () => {
      staged = false;
      rejected = true;
    },
    turnRejected: () => rejected,
    commit,
    discard
  };
  return { turn, commit, discard };
}

function privateGateDescriptor(): SystemConfigMutationDescriptor {
  return {
    action: "set_auto_reply",
    normalizedInput: {
      operation: "set_auto_reply",
      replyScope: "private",
      enabled: false,
      orchestratorEnabled: null,
      searchImplementation: null,
      bashAdminBackend: null,
      conversationId: null
    },
    closesCurrentPrivateReplyGate: true
  };
}

function heldHandle(overrides: {
  release?: () => Promise<void>;
  neutralizeAndRelease?: () => Promise<void>;
} = {}): SystemConfigHeldConfirmationHandle & {
  release: ReturnType<typeof vi.fn>;
  neutralizeAndRelease: ReturnType<typeof vi.fn>;
} {
  return {
    release: vi.fn(overrides.release ?? (async () => undefined)),
    neutralizeAndRelease: vi.fn(overrides.neutralizeAndRelease ?? (async () => undefined))
  };
}
