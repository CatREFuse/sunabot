// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  renderWithLightpanda,
  type LightpandaExecutor
} from "../../apps/webfetch-renderer/main.js";
import type { SafeProxyHandle } from "../../apps/webfetch-renderer/safeProxy.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

describe("Lightpanda WebFetch renderer", () => {
  it("runs one bounded process with the proxy budget and reads the final URL from base", async () => {
    const controller = new AbortController();
    const { proxy, closeBudget } = proxyFixture();
    const html = [
      "<!doctype html>",
      "<html><head><base href=\"http://example.test/final?ready=1\"></head>",
      "<body>Rendered content</body></html>"
    ].join("");
    execFileMock.mockReset();
    execFileMock.mockImplementation((...values: unknown[]) => {
      const callback = values.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, html, "");
    });

    await expect(renderWithLightpanda(
      "/opt/sunabot/lightpanda",
      proxy,
      "http://example.test/start",
      controller.signal
    )).resolves.toEqual({
      html: expect.stringContaining("Rendered content"),
      finalUrl: "http://example.test/final?ready=1"
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "/opt/sunabot/lightpanda",
      [
        "fetch",
        "--dump",
        "html",
        "--with-base",
        "--http-proxy",
        "http://127.0.0.1:19091",
        "--proxy-bearer-token",
        "budget-id",
        "--http-connect-timeout",
        "12000",
        "--http-max-response-size",
        String(4 * 1024 * 1024),
        "--http-timeout",
        "12000",
        "http://example.test/start"
      ],
      {
        encoding: "utf8",
        env: {
          LIGHTPANDA_DISABLE_CORE_DUMP: "1",
          LIGHTPANDA_DISABLE_TELEMETRY: "true"
        },
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        signal: controller.signal,
        timeout: 15_000,
        windowsHide: true
      },
      expect.any(Function)
    );
    expect(closeBudget).toHaveBeenCalledOnce();
  });

  it("closes the proxy budget when execution is aborted", async () => {
    const controller = new AbortController();
    const { proxy, closeBudget } = proxyFixture();
    const execute = vi.fn<LightpandaExecutor>(async (_executable, _args, options) => {
      expect(options.signal).toBe(controller.signal);
      throw new Error("aborted");
    });
    controller.abort(new Error("cancelled"));

    await expect(renderWithLightpanda(
      "/opt/sunabot/lightpanda",
      proxy,
      "http://example.test/start",
      controller.signal,
      execute
    )).rejects.toThrow("aborted");
    expect(closeBudget).toHaveBeenCalledOnce();
  });

  it("rejects missing final URL metadata and oversized output", async () => {
    const missing = proxyFixture();
    await expect(renderWithLightpanda(
      "/opt/sunabot/lightpanda",
      missing.proxy,
      "http://example.test/start",
      new AbortController().signal,
      async () => "<html><body>missing base</body></html>"
    )).rejects.toThrow("missing its final URL");
    expect(missing.closeBudget).toHaveBeenCalledOnce();

    const oversized = proxyFixture();
    await expect(renderWithLightpanda(
      "/opt/sunabot/lightpanda",
      oversized.proxy,
      "http://example.test/start",
      new AbortController().signal,
      async () => `<base href=\"http://example.test/final\">${"x".repeat(4 * 1024 * 1024)}`
    )).rejects.toThrow("rendered DOM too large");
    expect(oversized.closeBudget).toHaveBeenCalledOnce();
  });
});

function proxyFixture() {
  const closeBudget = vi.fn();
  const proxy = {
    url: "http://127.0.0.1:19091",
    openBudget: () => ({ id: "budget-id", close: closeBudget }),
    close: vi.fn(async () => undefined)
  } satisfies SafeProxyHandle;
  return { proxy, closeBudget };
}
