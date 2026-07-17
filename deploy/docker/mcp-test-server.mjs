#!/usr/local/bin/node
import readline from "node:readline";

const MAX_LINE_BYTES = 1024 * 1024;
const subscriptions = new Set();

const tools = [
  {
    name: "offline_echo",
    title: "Offline echo",
    description: "Returns one bounded offline text value.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 256 } },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "emit_list_changed",
    title: "Emit list changes",
    description: "Emits deterministic tools, resources, and prompts list change notifications.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const resources = [
  {
    uri: "sunabot://offline/readme",
    name: "Offline readme",
    description: "Static offline smoke resource.",
    mimeType: "text/plain"
  },
  {
    uri: "sunabot://offline/status",
    name: "Offline status",
    description: "Static offline readiness resource.",
    mimeType: "application/json"
  }
];

const resourceTemplates = [
  {
    uriTemplate: "sunabot://offline/items/{id}",
    name: "Offline item",
    description: "Reads one deterministic offline item.",
    mimeType: "text/plain"
  },
  {
    uriTemplate: "sunabot://offline/echo/{text}",
    name: "Offline URI echo",
    description: "Reads one bounded URI value without network access.",
    mimeType: "text/plain"
  }
];

const prompts = [
  {
    name: "offline_summary",
    title: "Offline summary",
    description: "Builds one deterministic offline summary prompt.",
    arguments: [{ name: "topic", description: "Topic to summarize.", required: true }]
  },
  {
    name: "offline_echo_prompt",
    title: "Offline echo prompt",
    description: "Builds one deterministic echo prompt.",
    arguments: [{ name: "text", description: "Text to echo.", required: true }]
  }
];

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return stop();
  let request;
  try { request = JSON.parse(line); } catch { return stop(); }
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return stop();
  if (request.id === undefined) {
    handleNotification(request);
    return;
  }
  Promise.resolve().then(() => handleRequest(request)).then(
    (result) => send({ jsonrpc: "2.0", id: request.id, result }),
    (error) => send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: Number.isSafeInteger(error?.code) ? error.code : -32603,
        message: typeof error?.message === "string" ? error.message : "Internal error"
      }
    })
  );
});

function handleNotification(request) {
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  stop();
}

function handleRequest(request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true }
        },
        serverInfo: { name: "sunabot-mcp-test-server", version: "1.0.0" },
        instructions: "Offline MCP protocol smoke server."
      };
    case "ping":
      return {};
    case "tools/list":
      return page(request.params, "tools", tools);
    case "tools/call":
      return callTool(request.params);
    case "resources/list":
      return page(request.params, "resources", resources);
    case "resources/templates/list":
      return page(request.params, "resourceTemplates", resourceTemplates);
    case "resources/read":
      return readResource(request.params);
    case "resources/subscribe":
      subscriptions.add(resourceUri(request.params));
      return {};
    case "resources/unsubscribe":
      subscriptions.delete(resourceUri(request.params));
      return {};
    case "prompts/list":
      return page(request.params, "prompts", prompts);
    case "prompts/get":
      return getPrompt(request.params);
    default:
      throw rpcError(-32601, "Method not found");
  }
}

function page(params, field, values) {
  const cursor = optionalCursor(params);
  if (cursor !== undefined && cursor !== `${field}:1`) throw rpcError(-32602, "Invalid cursor");
  const index = cursor === undefined ? 0 : 1;
  return {
    [field]: [values[index]],
    ...(index === 0 ? { nextCursor: `${field}:1` } : {})
  };
}

function optionalCursor(params) {
  if (params === undefined) return undefined;
  if (!plainRecord(params) || Object.keys(params).some((key) => key !== "cursor")) {
    throw rpcError(-32602, "Invalid params");
  }
  if (params.cursor === undefined) return undefined;
  if (typeof params.cursor !== "string" || params.cursor.length === 0 || params.cursor.length > 64) {
    throw rpcError(-32602, "Invalid cursor");
  }
  return params.cursor;
}

function callTool(params) {
  if (!plainRecord(params) || typeof params.name !== "string" || !plainRecord(params.arguments) ||
      Object.keys(params).some((key) => key !== "name" && key !== "arguments")) {
    throw rpcError(-32602, "Invalid params");
  }
  if (params.name === "offline_echo") {
    if (Object.keys(params.arguments).length !== 1 || typeof params.arguments.text !== "string" ||
        params.arguments.text.length > 256) throw rpcError(-32602, "Invalid params");
    return {
      content: [{ type: "text", text: params.arguments.text }],
      structuredContent: { text: params.arguments.text }
    };
  }
  if (params.name === "emit_list_changed") {
    if (Object.keys(params.arguments).length !== 0) throw rpcError(-32602, "Invalid params");
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
    for (const uri of [...subscriptions].sort()) {
      send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
    }
    return { content: [{ type: "text", text: "list_changed emitted" }] };
  }
  throw rpcError(-32602, "Unknown tool");
}

function readResource(params) {
  const uri = resourceUri(params);
  if (uri === resources[0].uri) {
    return { contents: [{ uri, mimeType: "text/plain", text: "Sunabot offline MCP smoke resource." }] };
  }
  if (uri === resources[1].uri) {
    return { contents: [{ uri, mimeType: "application/json", text: '{"ready":true,"network":false}' }] };
  }
  const item = /^sunabot:\/\/offline\/items\/([A-Za-z0-9_-]{1,64})$/u.exec(uri);
  if (item) return { contents: [{ uri, mimeType: "text/plain", text: `offline item ${item[1]}` }] };
  const echo = /^sunabot:\/\/offline\/echo\/([A-Za-z0-9_-]{1,64})$/u.exec(uri);
  if (echo) return { contents: [{ uri, mimeType: "text/plain", text: echo[1] }] };
  throw rpcError(-32002, "Resource not found");
}

function resourceUri(params) {
  if (!plainRecord(params) || Object.keys(params).length !== 1 || typeof params.uri !== "string" ||
      params.uri.length === 0 || params.uri.length > 256) throw rpcError(-32602, "Invalid params");
  return params.uri;
}

function getPrompt(params) {
  if (!plainRecord(params) || typeof params.name !== "string" || !plainRecord(params.arguments) ||
      Object.keys(params).some((key) => key !== "name" && key !== "arguments")) {
    throw rpcError(-32602, "Invalid params");
  }
  const argumentName = params.name === "offline_summary" ? "topic"
    : params.name === "offline_echo_prompt" ? "text" : undefined;
  const value = argumentName ? params.arguments[argumentName] : undefined;
  if (!argumentName || Object.keys(params.arguments).length !== 1 || typeof value !== "string" ||
      value.length === 0 || value.length > 256) throw rpcError(-32602, "Invalid params");
  return {
    description: params.name === "offline_summary" ? "Offline summary prompt." : "Offline echo prompt.",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: params.name === "offline_summary" ? `Summarize offline topic: ${value}` : value
      }
    }]
  };
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function stop() {
  process.exitCode = 1;
  lines.close();
  process.stdin.destroy();
}
