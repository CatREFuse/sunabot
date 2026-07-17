// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { withFastifyRequestSignal } from "../../apps/api/plugins/requestAbortSignal.js";

describe("MCP Fastify request cancellation", () => {
  it("aborts after the request body completed when the response socket closes", async () => {
    const fixture = lifecycle();
    let observed: AbortSignal | undefined;
    const running = withFastifyRequestSignal(
      fixture.request as never,
      fixture.reply as never,
      "MCP_REQUEST_ABORTED",
      async (signal) => {
        observed = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "late";
      }
    );
    fixture.socket.emit("close");
    await expect(running).rejects.toThrow("MCP_REQUEST_ABORTED");
    expect(observed?.aborted).toBe(true);
    expect(fixture.requestRaw.listenerCount("aborted")).toBe(0);
    expect(fixture.socket.listenerCount("close")).toBe(0);
    expect(fixture.replyRaw.listenerCount("close")).toBe(0);
  });

  it("does not abort a normally finished response and removes every listener", async () => {
    const fixture = lifecycle();
    let observed: AbortSignal | undefined;
    const result = await withFastifyRequestSignal(
      fixture.request as never,
      fixture.reply as never,
      "MCP_OAUTH_REQUEST_ABORTED",
      async (signal) => {
        observed = signal;
        fixture.replyRaw.writableFinished = true;
        fixture.replyRaw.writableEnded = true;
        fixture.replyRaw.emit("close");
        return "ok";
      }
    );
    expect(result).toBe("ok");
    expect(observed?.aborted).toBe(false);
    expect(fixture.requestRaw.listenerCount("aborted")).toBe(0);
    expect(fixture.socket.listenerCount("close")).toBe(0);
    expect(fixture.replyRaw.listenerCount("close")).toBe(0);
  });

  it("forwards one abort signal to an OAuth reservation and never resolves a late response", async () => {
    const fixture = lifecycle();
    const closeReservation = vi.fn(async () => undefined);
    let release!: () => void;
    const running = withFastifyRequestSignal(
      fixture.request as never,
      fixture.reply as never,
      "MCP_OAUTH_REQUEST_ABORTED",
      async (signal) => {
        signal.addEventListener("abort", () => { void closeReservation(); }, { once: true });
        await new Promise<void>((resolve) => { release = resolve; });
        if (signal.aborted) throw signal.reason;
        return "late";
      }
    );
    fixture.replyRaw.emit("close");
    release();
    await expect(running).rejects.toThrow("MCP_OAUTH_REQUEST_ABORTED");
    expect(closeReservation).toHaveBeenCalledOnce();
  });
});

function lifecycle() {
  const socket = new EventEmitter();
  const requestRaw = Object.assign(new EventEmitter(), { socket });
  const replyRaw = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writableEnded: false
  });
  return {
    socket,
    requestRaw,
    replyRaw,
    request: { raw: requestRaw },
    reply: { raw: replyRaw }
  };
}
