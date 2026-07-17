// @vitest-environment node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const server = fileURLToPath(new URL("../../deploy/docker/mcp-test-server.mjs", import.meta.url));

describe("offline Docker MCP smoke server", () => {
  it("covers every V1 server primitive with deterministic pagination and listChanged notifications", async () => {
    const messages = await runServer([
      request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "offline-test", version: "1.0.0" }
      }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request(2, "tools/list"),
      request(3, "tools/list", { cursor: "tools:1" }),
      request(4, "tools/call", { name: "offline_echo", arguments: { text: "offline" } }),
      request(5, "resources/list"),
      request(6, "resources/list", { cursor: "resources:1" }),
      request(7, "resources/templates/list"),
      request(8, "resources/templates/list", { cursor: "resourceTemplates:1" }),
      request(9, "resources/read", { uri: "sunabot://offline/readme" }),
      request(10, "resources/read", { uri: "sunabot://offline/items/42" }),
      request(11, "resources/subscribe", { uri: "sunabot://offline/readme" }),
      request(12, "prompts/list"),
      request(13, "prompts/list", { cursor: "prompts:1" }),
      request(14, "prompts/get", { name: "offline_summary", arguments: { topic: "MCP" } }),
      request(15, "tools/call", { name: "emit_list_changed", arguments: {} }),
      request(16, "resources/unsubscribe", { uri: "sunabot://offline/readme" }),
      request(17, "ping")
    ]);

    expect(result(messages, 1)).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true }
      }
    });
    expect(result(messages, 2)).toMatchObject({
      tools: [{ name: "offline_echo" }],
      nextCursor: "tools:1"
    });
    expect(result(messages, 3)).toMatchObject({ tools: [{ name: "emit_list_changed" }] });
    expect(result(messages, 3)).not.toHaveProperty("nextCursor");
    expect(result(messages, 4)).toEqual({
      content: [{ type: "text", text: "offline" }],
      structuredContent: { text: "offline" }
    });
    expect(result(messages, 5)).toMatchObject({
      resources: [{ uri: "sunabot://offline/readme" }],
      nextCursor: "resources:1"
    });
    expect(result(messages, 6)).toMatchObject({ resources: [{ uri: "sunabot://offline/status" }] });
    expect(result(messages, 7)).toMatchObject({
      resourceTemplates: [{ uriTemplate: "sunabot://offline/items/{id}" }],
      nextCursor: "resourceTemplates:1"
    });
    expect(result(messages, 8)).toMatchObject({
      resourceTemplates: [{ uriTemplate: "sunabot://offline/echo/{text}" }]
    });
    expect(result(messages, 9)).toEqual({
      contents: [{
        uri: "sunabot://offline/readme",
        mimeType: "text/plain",
        text: "Sunabot offline MCP smoke resource."
      }]
    });
    expect(result(messages, 10)).toMatchObject({
      contents: [{ uri: "sunabot://offline/items/42", text: "offline item 42" }]
    });
    expect(result(messages, 12)).toMatchObject({
      prompts: [{ name: "offline_summary" }],
      nextCursor: "prompts:1"
    });
    expect(result(messages, 13)).toMatchObject({ prompts: [{ name: "offline_echo_prompt" }] });
    expect(result(messages, 14)).toMatchObject({
      messages: [{ role: "user", content: { type: "text", text: "Summarize offline topic: MCP" } }]
    });
    expect(result(messages, 15)).toEqual({ content: [{ type: "text", text: "list_changed emitted" }] });
    expect(result(messages, 17)).toEqual({});

    const notifications = messages
      .filter((message) => message.id === undefined)
      .map((message) => ({ method: message.method, params: message.params }));
    expect(notifications).toEqual(expect.arrayContaining([
      { method: "notifications/tools/list_changed", params: undefined },
      { method: "notifications/resources/list_changed", params: undefined },
      { method: "notifications/prompts/list_changed", params: undefined },
      {
        method: "notifications/resources/updated",
        params: { uri: "sunabot://offline/readme" }
      }
    ]));
  });

  it("returns stable protocol errors for invalid pagination and unknown methods", async () => {
    const messages = await runServer([
      request(1, "initialize", {}),
      request(2, "tools/list", { cursor: "wrong" }),
      request(3, "resources/read", { uri: "file:///etc/passwd" }),
      request(4, "sampling/createMessage", {})
    ]);

    expect(error(messages, 2)).toEqual({ code: -32602, message: "Invalid cursor" });
    expect(error(messages, 3)).toEqual({ code: -32002, message: "Resource not found" });
    expect(error(messages, 4)).toEqual({ code: -32601, message: "Method not found" });
    expect(JSON.stringify(messages)).not.toContain("/Users/");
  });
});

function request(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

async function runServer(input: unknown[]): Promise<Array<Record<string, unknown>>> {
  const child = spawn(process.execPath, [server], {
    cwd: "/",
    env: {},
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(`${input.map((message) => JSON.stringify(message)).join("\n")}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("OFFLINE_MCP_TEST_TIMEOUT"));
    }, 5_000);
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  expect({ code, stderr: Buffer.concat(stderr).toString("utf8") }).toEqual({ code: 0, stderr: "" });
  return Buffer.concat(stdout).toString("utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function result(messages: Array<Record<string, unknown>>, id: number) {
  return messages.find((message) => message.id === id)?.result as Record<string, unknown>;
}

function error(messages: Array<Record<string, unknown>>, id: number) {
  return messages.find((message) => message.id === id)?.error;
}
