// @vitest-environment node
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_OAUTH_LOOPBACK_CALLBACK_PATH,
  McpOAuthLoopbackBroker
} from "../../adapters/mcp/oauthLoopbackBroker.js";

describe("MCP OAuth loopback broker", () => {
  it("reserves an ephemeral loopback callback before activating one exact state", async () => {
    const broker = new McpOAuthLoopbackBroker();
    const reservation = await broker.reserve();
    const redirect = new URL(reservation.redirectUri);
    const port = Number(redirect.port);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe(MCP_OAUTH_LOOPBACK_CALLBACK_PATH);
    expect(port).toBeGreaterThanOrEqual(49_152);
    expect(port).toBeLessThanOrEqual(65_535);
    expect(port).not.toBe(8_787);

    const beforeActivation = await get(`${reservation.redirectUri}?state=future-state&code=future-code`);
    expect(beforeActivation.status).toBe(400);
    expect(beforeActivation.body).toContain("授权未完成");
    expect(beforeActivation.body).not.toContain("future-state");
    expect(beforeActivation.body).not.toContain("future-code");

    const onCallback = vi.fn().mockResolvedValue(undefined);
    reservation.activate({
      state: "expected-state",
      expiresAt: Date.now() + 5_000,
      onCallback
    });
    const completed = await get(`${reservation.redirectUri}?code=authorization-code&state=expected-state`);
    expect(completed.status).toBe(200);
    expect(completed.body).toContain("授权完成");
    expect(completed.body).not.toContain("expected-state");
    expect(completed.body).not.toContain("authorization-code");
    expect(completed.headers["cache-control"]).toContain("no-store");
    expect(completed.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(onCallback).toHaveBeenCalledWith({
      state: "expected-state",
      code: "authorization-code",
      signal: expect.any(AbortSignal)
    });
    await reservation.close();
    await reservation.close();
    await expect(get(`${reservation.redirectUri}?state=expected-state&code=authorization-code`)).rejects.toThrow();
  });

  it("retries occupied high ports and rejects every non-ephemeral candidate", async () => {
    const occupied = await occupyHighPort();
    try {
      const address = occupied.address();
      if (!address || typeof address === "string") throw new Error("TEST_PORT_UNAVAILABLE");
      let candidate = address.port;
      const reservation = await new McpOAuthLoopbackBroker({
        portCandidate: () => candidate--
      }).reserve();
      expect(Number(new URL(reservation.redirectUri).port)).not.toBe(address.port);
      await reservation.close();
    } finally {
      await closeServer(occupied);
    }

    await expect(new McpOAuthLoopbackBroker({ portCandidate: () => 8_787 }).reserve())
      .rejects.toThrow("MCP_OAUTH_LOOPBACK_CONFIG_INVALID");
    await expect(new McpOAuthLoopbackBroker({ portCandidate: () => 0 }).reserve())
      .rejects.toThrow("MCP_OAUTH_LOOPBACK_CONFIG_INVALID");
  });

  it("rejects mismatched, duplicate, error, extra, oversized, and non-GET requests without consuming state", async () => {
    const reservation = await new McpOAuthLoopbackBroker().reserve();
    const onCallback = vi.fn().mockResolvedValue(undefined);
    reservation.activate({ state: "valid-state", expiresAt: Date.now() + 5_000, onCallback });
    const invalidTargets = [
      `${reservation.redirectUri}?state=wrong-state&code=valid-code`,
      `${reservation.redirectUri}?state=valid-state&state=valid-state&code=valid-code`,
      `${reservation.redirectUri}?state=valid-state&code=valid-code&extra=true`,
      `${reservation.redirectUri}?state=valid-state&code=valid-code&error=denied`,
      `${reservation.redirectUri}?state=valid-state&code=valid-code&`,
      `${reservation.redirectUri}?st%61te=valid-state&code=valid-code`,
      `${reservation.redirectUri}?state=valid-state&code=`,
      `${reservation.redirectUri}?state=valid-state&code=${"x".repeat(2_100)}`
    ];
    for (const target of invalidTargets) {
      const response = await get(target);
      expect(response.status).toBe(400);
      expect(response.body).toContain("授权未完成");
      expect(response.body).not.toContain("valid-state");
      expect(response.body).not.toContain("denied");
    }
    expect((await get(`${reservation.redirectUri}?state=valid-state&code=valid-code`, { method: "POST" })).status).toBe(400);
    expect((await get(`${reservation.redirectUri}?state=valid-state&code=valid-code`, {
      headers: { host: "attacker.example.test" }
    })).status).toBe(400);
    expect(onCallback).not.toHaveBeenCalled();

    const valid = await get(`${reservation.redirectUri}?state=valid-state&code=valid-code`);
    expect(valid.status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(1);
    await reservation.close();
  });

  it("consumes concurrent valid callbacks exactly once", async () => {
    const reservation = await new McpOAuthLoopbackBroker().reserve();
    let release!: () => void;
    const onCallback = vi.fn().mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    reservation.activate({ state: "single-state", expiresAt: Date.now() + 5_000, onCallback });
    const target = `${reservation.redirectUri}?state=single-state&code=single-code`;
    const first = get(target);
    await vi.waitFor(() => expect(onCallback).toHaveBeenCalledTimes(1));
    const second = get(target).catch(() => undefined);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.filter((response) => response?.status === 200)).toHaveLength(1);
    expect(onCallback).toHaveBeenCalledTimes(1);
    await reservation.close();
  });

  it("returns a generic failure and closes after callback errors", async () => {
    const reservation = await new McpOAuthLoopbackBroker().reserve();
    reservation.activate({
      state: "failure-state",
      expiresAt: Date.now() + 5_000,
      onCallback: async () => {
        throw new Error("secret-code /Users/private/oauth-token");
      }
    });
    const response = await get(`${reservation.redirectUri}?state=failure-state&code=secret-code`);
    expect(response.status).toBe(400);
    expect(response.body).toContain("授权未完成");
    expect(response.body).not.toContain("secret-code");
    expect(response.body).not.toContain("/Users/private");
    await reservation.close();
    await expect(get(`${reservation.redirectUri}?state=failure-state&code=secret-code`)).rejects.toThrow();
  });

  it("aborts a hanging callback at its bounded deadline and closes the listener", async () => {
    const broker = new McpOAuthLoopbackBroker({ callbackTimeoutMs: 40 });
    const reservation = await broker.reserve();
    let callbackSignal: AbortSignal | undefined;
    reservation.activate({
      state: "timeout-state",
      expiresAt: Date.now() + 5_000,
      onCallback: ({ signal }) => {
        callbackSignal = signal;
        return new Promise<void>(() => undefined);
      }
    });
    const response = await get(`${reservation.redirectUri}?state=timeout-state&code=timeout-code`);
    expect(response.status).toBe(400);
    expect(response.body).toContain("授权未完成");
    expect(callbackSignal?.aborted).toBe(true);
    await reservation.close();
    await expect(get(`${reservation.redirectUri}?state=timeout-state&code=timeout-code`)).rejects.toThrow();
  });

  it("closes an unactivated reservation on timeout, abort, or explicit close", async () => {
    const timed = await new McpOAuthLoopbackBroker({ activationTimeoutMs: 30 }).reserve();
    await vi.waitFor(async () => {
      await expect(get(`${timed.redirectUri}?state=x&code=y`)).rejects.toThrow();
    }, { timeout: 1_000 });
    await timed.close();

    const controller = new AbortController();
    const aborted = await new McpOAuthLoopbackBroker().reserve({ signal: controller.signal });
    controller.abort();
    await aborted.close();
    await expect(get(`${aborted.redirectUri}?state=x&code=y`)).rejects.toThrow();

    const closed = await new McpOAuthLoopbackBroker().reserve();
    await closed.close();
    await expect(get(`${closed.redirectUri}?state=x&code=y`)).rejects.toThrow();
  });

  it("activates once and fails closed on invalid activation", async () => {
    const reservation = await new McpOAuthLoopbackBroker().reserve();
    reservation.activate({ state: "first-state", expiresAt: Date.now() + 5_000, onCallback: vi.fn() });
    expect(() => reservation.activate({
      state: "second-state",
      expiresAt: Date.now() + 5_000,
      onCallback: vi.fn()
    })).toThrow("MCP_OAUTH_LOOPBACK_ALREADY_ACTIVATED");
    await reservation.close();

    const invalid = await new McpOAuthLoopbackBroker().reserve();
    expect(() => invalid.activate({
      state: "expired-state",
      expiresAt: Date.now() - 1,
      onCallback: vi.fn()
    })).toThrow("MCP_OAUTH_LOOPBACK_ACTIVATION_INVALID");
    await invalid.close();
    await expect(get(`${invalid.redirectUri}?state=expired-state&code=code`)).rejects.toThrow();
  });

  it("rechecks abort atomically after listener registration", async () => {
    const reserveController = new AbortController();
    const reserveSignal = abortDuringRegistration(reserveController);
    await expect(new McpOAuthLoopbackBroker().reserve({ signal: reserveSignal }))
      .rejects.toThrow("MCP_OAUTH_LOOPBACK_ABORTED");

    const reservation = await new McpOAuthLoopbackBroker().reserve();
    const activateController = new AbortController();
    const activateSignal = abortDuringRegistration(activateController);
    expect(() => reservation.activate({
      state: "abort-state",
      expiresAt: Date.now() + 5_000,
      signal: activateSignal,
      onCallback: vi.fn()
    })).toThrow("MCP_OAUTH_LOOPBACK_ABORTED");
    await reservation.close();
    await expect(get(`${reservation.redirectUri}?state=abort-state&code=code`)).rejects.toThrow();
  });

  it("enforces reservation and active deadlines synchronously after event-loop delay", async () => {
    let now = 10_000;
    const expiredReservation = await new McpOAuthLoopbackBroker({
      now: () => now,
      activationTimeoutMs: 1_000
    }).reserve();
    now = 11_001;
    expect(() => expiredReservation.activate({
      state: "late-state",
      expiresAt: now + 5_000,
      onCallback: vi.fn()
    })).toThrow("MCP_OAUTH_LOOPBACK_ACTIVATION_INVALID");
    await expiredReservation.close();

    now = 20_000;
    const expiredCallback = await new McpOAuthLoopbackBroker({ now: () => now }).reserve();
    const onCallback = vi.fn();
    expiredCallback.activate({ state: "expired-state", expiresAt: 25_000, onCallback });
    now = 25_001;
    const response = await get(`${expiredCallback.redirectUri}?state=expired-state&code=code`);
    expect(response.status).toBe(400);
    expect(onCallback).not.toHaveBeenCalled();
    await expiredCallback.close();
  });

  it("freezes the validated activation before accepting callbacks", async () => {
    const reservation = await new McpOAuthLoopbackBroker().reserve();
    const original = vi.fn().mockResolvedValue(undefined);
    const replacement = vi.fn().mockResolvedValue(undefined);
    const activation = {
      state: "frozen-state",
      expiresAt: Date.now() + 5_000,
      onCallback: original
    };
    reservation.activate(activation);
    activation.state = "replacement-state";
    activation.expiresAt = Date.now() - 1;
    activation.onCallback = replacement;
    expect((await get(`${reservation.redirectUri}?state=frozen-state&code=code`)).status).toBe(200);
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    await reservation.close();
  });

  it("does not report success when synchronous callback work crosses its deadline", async () => {
    let now = 30_000;
    const reservation = await new McpOAuthLoopbackBroker({
      now: () => now,
      callbackTimeoutMs: 1_000
    }).reserve();
    const onCallback = vi.fn(() => {
      now = 31_001;
    });
    reservation.activate({ state: "slow-state", expiresAt: 40_000, onCallback });
    const response = await get(`${reservation.redirectUri}?state=slow-state&code=code`);
    expect(response.status).toBe(400);
    expect(response.body).toContain("授权未完成");
    expect(onCallback).toHaveBeenCalledTimes(1);
    await reservation.close();
  });

  it("rejects oversized headers while preserving the pending valid callback", async () => {
    const reservation = await new McpOAuthLoopbackBroker().reserve();
    const onCallback = vi.fn().mockResolvedValue(undefined);
    reservation.activate({ state: "header-state", expiresAt: Date.now() + 5_000, onCallback });
    const oversized = await get(`${reservation.redirectUri}?state=header-state&code=header-code`, {
      headers: { "x-oversized": "x".repeat(9 * 1_024) }
    });
    expect(oversized.status).toBeGreaterThanOrEqual(400);
    expect(oversized.body).toContain("授权未完成");
    expect(oversized.body).not.toContain("header-state");
    expect(onCallback).not.toHaveBeenCalled();
    expect((await get(`${reservation.redirectUri}?state=header-state&code=header-code`)).status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(1);
    await reservation.close();
  });
});

function get(target: string, options: {
  method?: string;
  headers?: Record<string, string>;
} = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request(target, {
      method: options.method ?? "GET",
      headers: options.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function occupyHighPort() {
  for (let port = 65_535; port >= 65_500; port -= 1) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host: "127.0.0.1", port, exclusive: true });
      });
      return server;
    } catch {
      if (server.listening) await closeServer(server);
    }
  }
  throw new Error("TEST_PORT_UNAVAILABLE");
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function abortDuringRegistration(controller: AbortController) {
  const signal = controller.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
      controller.abort();
      addEventListener(...args);
    }
  });
  return signal;
}
