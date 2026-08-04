// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { SunaRuntime } from "../../src/runtime.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("runtime lifecycle cancellation", () => {
  it("hard-settles incoming preparation on close and blocks every later stage", async () => {
    const runtime = await createRuntime();
    let hydrateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hydrateStarted = resolve;
    });
    let releaseHydrate!: () => void;
    vi.spyOn(runtime.senderNameResolver, "hydrate").mockImplementation(() => {
      hydrateStarted();
      return new Promise<void>((resolve) => {
        releaseHydrate = resolve;
      });
    });
    const attachReplyReferences = vi.spyOn(runtime, "attachReplyReferences");
    const incoming = privateIncoming();
    const pending = runtime.prepareIncomingMessage(incoming, {} as MessagingPort);
    await started;

    runtime.close();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.runtimeSignal.aborted).toBe(true);

    releaseHydrate();
    await Promise.resolve();
    await Promise.resolve();
    expect(attachReplyReferences).not.toHaveBeenCalled();
  });

  it("aborts active reply work and removes every close-time timer", async () => {
    vi.useFakeTimers();
    const runtime = await createRuntime();
    const direct = new AbortController();
    const ambient = new AbortController();
    const internals = runtime as unknown as {
      activeDirectControllers: Map<string, AbortController>;
      ambientReplies: Map<string, {
        epoch: number;
        running: boolean;
        next?: unknown;
        controller?: AbortController;
      }>;
      ambientIdleTimers: Map<string, { timer: NodeJS.Timeout; job: unknown }>;
      incomingPreparations: Map<string, { promise: Promise<void>; incoming: ParsedIncomingMessage }>;
      attachmentRefreshDirty: boolean;
    };
    internals.activeDirectControllers.set("private:1", direct);
    internals.ambientReplies.set("group:1", {
      epoch: 0,
      running: true,
      next: {},
      controller: ambient
    });
    internals.ambientIdleTimers.set("group:1", {
      timer: setTimeout(() => undefined, 60_000),
      job: {}
    });
    internals.incomingPreparations.set("incoming:1", {
      promise: new Promise<void>(() => undefined),
      incoming: privateIncoming()
    });
    internals.attachmentRefreshDirty = true;

    runtime.close();

    expect(direct.signal.aborted).toBe(true);
    expect(ambient.signal.aborted).toBe(true);
    expect(internals.activeDirectControllers.size).toBe(0);
    expect(internals.ambientIdleTimers.size).toBe(0);
    expect(internals.incomingPreparations.size).toBe(0);
    expect(internals.attachmentRefreshDirty).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function createRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-lifecycle-"));
  roots.push(root);
  return new SunaRuntime(createAdminTestConfig(root), {
    attachmentService: {} as never
  });
}

function privateIncoming(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    transport: "onebot",
    scope: "private",
    messageId: 7001,
    time: "2026-07-31T12:00:00.000+08:00",
    userId: 171419991,
    sender: {
      id: "171419991",
      nickname: "管理员",
      displayName: "管理员"
    },
    text: "检查关闭行为",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: true
  };
}
