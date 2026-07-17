// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  HardenedStdioTransport,
  type HardenedStdioLaunchHandlers,
  type HardenedStdioLaunchSpec,
  type HardenedStdioProcess,
  type HardenedStdioProcessLauncher
} from "../../adapters/mcp/hardenedStdioTransport.js";

class FakeProcess implements HardenedStdioProcess {
  readonly writes: string[] = [];
  readonly lifecycle: string[] = [];
  private waitResults = [false, false, true];

  async writeStdin(value: string) {
    this.writes.push(value);
  }

  async closeStdin() {
    this.lifecycle.push("stdin");
  }

  async waitForExit(timeoutMs: number) {
    this.lifecycle.push(`wait:${timeoutMs}`);
    return this.waitResults.shift() ?? true;
  }

  async terminateGroup(signal: "SIGTERM" | "SIGKILL") {
    this.lifecycle.push(signal);
  }
}

class FakeLauncher implements HardenedStdioProcessLauncher {
  spec?: HardenedStdioLaunchSpec;
  snapshot?: HardenedStdioLaunchSpec;
  handlers?: HardenedStdioLaunchHandlers;
  readonly process = new FakeProcess();

  async launch(spec: HardenedStdioLaunchSpec, handlers: HardenedStdioLaunchHandlers) {
    this.spec = spec;
    this.snapshot = { ...spec, args: [...spec.args], env: { ...spec.env } };
    this.handlers = handlers;
    return this.process;
  }
}

function createTransport(overrides: Partial<ConstructorParameters<typeof HardenedStdioTransport>[0]> = {}) {
  const launcher = new FakeLauncher();
  const transport = new HardenedStdioTransport({
    command: "/usr/local/bin/example-mcp",
    args: ["--stdio"],
    env: { MCP_TOKEN: "top-secret" },
    launcher,
    maxMessageBytes: 256,
    maxStderrBytes: 32,
    closeGraceMs: 25,
    ...overrides
  });
  return { launcher, transport };
}

describe("HardenedStdioTransport", () => {
  it("launches through an injected strong-isolation launcher with an exact environment", async () => {
    const { launcher, transport } = createTransport();

    await transport.start();

    expect(launcher.snapshot).toEqual({
      command: "/usr/local/bin/example-mcp",
      args: ["--stdio"],
      cwd: "/workbench",
      env: { MCP_TOKEN: "top-secret" },
      inheritEnv: false,
      stderr: "pipe",
      killScope: "process_group"
    });
    expect(launcher.snapshot?.env).not.toHaveProperty("HOME");
    expect(launcher.snapshot?.env).not.toHaveProperty("PATH");
    expect(launcher.snapshot?.env).not.toHaveProperty("HTTP_PROXY");
    expect(launcher.spec?.env).toEqual({});
    expect(launcher.spec?.args).toEqual([]);
    expect(JSON.stringify(launcher.spec)).not.toContain("top-secret");
  });

  it("frames bounded JSON-RPC without using the SDK stdio transport", async () => {
    const { launcher, transport } = createTransport();
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();

    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    launcher.handlers?.stdout(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));

    expect(launcher.process.writes).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']);
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("fails closed on oversized messages and never exposes stderr contents", async () => {
    const { launcher, transport } = createTransport({ maxMessageBytes: 48, maxStderrBytes: 8 });
    const errors: string[] = [];
    transport.onerror = (error) => errors.push(error.message);
    await transport.start();

    launcher.handlers?.stderr(Buffer.from("token=very-secret /Users/admin/private\n"));
    launcher.handlers?.stdout(Buffer.from("x".repeat(49)));

    expect(transport.stderrSummary()).toEqual({ byteLength: 39, truncated: true });
    expect(JSON.stringify(transport.stderrSummary())).not.toContain("secret");
    expect(errors).toEqual(["MCP_STDIO_MESSAGE_TOO_LARGE"]);
  });

  it("strictly closes after the first malformed complete frame and drops later frames", async () => {
    const { launcher, transport } = createTransport();
    const errors: string[] = [];
    const received: JSONRPCMessage[] = [];
    const onclose = vi.fn();
    transport.onerror = (error) => errors.push(error.message);
    transport.onmessage = (message) => received.push(message);
    transport.onclose = onclose;
    await transport.start();

    launcher.handlers?.stdout(Buffer.from('{"jsonrpc":"2.0",bad}\n{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());

    expect(errors).toEqual(["MCP_STDIO_MESSAGE_INVALID"]);
    expect(received).toEqual([]);
    expect(launcher.process.lifecycle).toEqual([
      "stdin", "wait:25", "SIGTERM", "wait:25", "SIGKILL", "wait:25"
    ]);
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping" }))
      .rejects.toThrow("MCP_STDIO_NOT_RUNNING");
    launcher.handlers?.stdout(Buffer.from('{"jsonrpc":"2.0","id":3,"result":{}}\n'));
    expect(received).toEqual([]);
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("rejects malformed UTF-8 split across chunks before JSON normalization", async () => {
    const { launcher, transport } = createTransport();
    const errors: string[] = [];
    const received: JSONRPCMessage[] = [];
    const onclose = vi.fn();
    transport.onerror = (error) => errors.push(error.message);
    transport.onmessage = (message) => received.push(message);
    transport.onclose = onclose;
    await transport.start();

    launcher.handlers?.stdout(Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"value":"'),
      Buffer.from([0xc3])
    ]));
    launcher.handlers?.stdout(Buffer.concat([
      Buffer.from([0x28]),
      Buffer.from('"}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n')
    ]));
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());

    expect(errors).toEqual(["MCP_STDIO_MESSAGE_INVALID"]);
    expect(received).toEqual([]);
    expect(launcher.process.lifecycle).toEqual([
      "stdin", "wait:25", "SIGTERM", "wait:25", "SIGKILL", "wait:25"
    ]);
  });

  it("closes stdin, then the process group with TERM and KILL under bounded waits", async () => {
    const { launcher, transport } = createTransport();
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();

    await transport.close();

    expect(launcher.process.lifecycle).toEqual([
      "stdin",
      "wait:25",
      "SIGTERM",
      "wait:25",
      "SIGKILL",
      "wait:25"
    ]);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("reaches TERM and KILL even when closing stdin never settles", async () => {
    vi.useFakeTimers();
    const { launcher, transport } = createTransport({ closeGraceMs: 10 });
    launcher.process.closeStdin = vi.fn(async () => {
      launcher.process.lifecycle.push("stdin-blocked");
      await new Promise<void>(() => undefined);
    });
    await transport.start();
    const closing = transport.close();
    await vi.advanceTimersByTimeAsync(11);
    await closing;
    expect(launcher.process.lifecycle).toEqual([
      "stdin-blocked",
      "wait:10",
      "SIGTERM",
      "wait:10",
      "SIGKILL",
      "wait:10"
    ]);
    vi.useRealTimers();
  });

  it.each([
    { command: "mcp-server" },
    { command: "/usr/local/bin/mcp\0server" },
    { args: ["ok", "bad\0arg"] },
    { env: { HOME: "/host" } },
    { env: { HTTP_PROXY: "http://proxy" } },
    { env: { SAFE: "bad\0value" } }
  ])("rejects unsafe launch configuration %#", async (override) => {
    const { transport } = createTransport(override);
    await expect(transport.start()).rejects.toThrow("MCP_STDIO_CONFIG_INVALID");
    expect((transport as unknown as { environment: Record<string, string> }).environment).toEqual({});
    expect((transport as unknown as { args: string[] }).args).toEqual([]);
  });

  it("clears transient arguments and environment when the launcher rejects", async () => {
    let specReference: HardenedStdioLaunchSpec | undefined;
    const launcher: HardenedStdioProcessLauncher = {
      launch: vi.fn(async (spec) => {
        specReference = spec;
        throw new Error("launcher failed");
      })
    };
    const transport = new HardenedStdioTransport({
      command: "/usr/local/bin/example-mcp",
      args: ["--stdio"],
      env: { MCP_TOKEN: "top-secret" },
      launcher
    });

    await expect(transport.start()).rejects.toThrow("MCP_STDIO_LAUNCH_FAILED");
    expect(specReference?.args).toEqual([]);
    expect(specReference?.env).toEqual({});
    expect(JSON.stringify(specReference)).not.toContain("top-secret");
    expect((transport as unknown as { environment: Record<string, string> }).environment).toEqual({});
    expect((transport as unknown as { args: string[] }).args).toEqual([]);
  });

  it("rejects invalid resource limits before launch", () => {
    expect(() => createTransport({ maxMessageBytes: 0 })).toThrow("MCP_STDIO_CONFIG_INVALID");
    expect(() => createTransport({ closeGraceMs: 10_001 })).toThrow("MCP_STDIO_CONFIG_INVALID");
  });
});
