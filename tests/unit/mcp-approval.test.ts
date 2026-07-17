// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_APPROVAL_ARGUMENT_MAX_BYTES,
  McpToolApprovalTransactions
} from "../../services/extensions/mcpApproval.js";

describe("MCP chat approval transactions", () => {
  it("issues one bounded ticket, confirms from the exact conversation and consumes once", () => {
    let now = Date.parse("2026-07-17T00:00:00.000Z");
    const store = new McpToolApprovalTransactions({ now: () => now, ttlMs: 60_000 });
    const request = approvalRequest();
    const first = store.resolve(request);
    expect(first).toMatchObject({
      ok: false,
      approvalRequired: true,
      confirmationText: expect.stringMatching(/^\/确认 MCP mcpa_/u),
      summary: "MCP server-a/search",
      serverId: "server-a",
      toolName: "search",
      arguments: { page: 1, query: "status" },
      argumentsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(store.resolve({ ...request, callId: "call-retry" })).toEqual(first);
    const confirmationText = (first as { confirmationText: string }).confirmationText;
    expect(store.confirm(confirmationText, approvalContext())).toBe(true);
    expect(store.resolve({
      ...request,
      callId: "call-after-confirm",
      arguments: { page: 1, query: "status" }
    })).toBe(true);
    expect(store.confirm(confirmationText, approvalContext())).toBe(false);
    expect(store.resolve(request)).toMatchObject({ approvalRequired: true });
    now += 1;
  });

  it("binds approval to every identity, catalog generation and canonical arguments", () => {
    const mutations = [
      { agentId: "agent-b" },
      { accountId: "secondary" },
      { transport: "web" as const },
      { conversationId: "private:2" },
      { userId: 2 },
      { serverId: "server-b" },
      { toolName: "write" },
      { snapshotDigest: "b".repeat(64) },
      { catalogGeneration: 2 },
      { arguments: { query: "different", page: 1 } }
    ];
    for (const mutation of mutations) {
      const store = new McpToolApprovalTransactions({ now: () => 1_000 });
      const request = approvalRequest();
      const issued = store.resolve(request) as { confirmationText: string };
      expect(store.confirm(issued.confirmationText, approvalContext())).toBe(true);
      expect(store.resolve({ ...request, ...mutation, callId: "retry" })).toMatchObject({
        approvalRequired: true
      });
      expect(store.resolve({ ...request, callId: "original-retry" })).toBe(true);
    }
  });

  it("rejects cross-context confirmation, expires tickets and never mode does not issue", () => {
    let now = 1_000;
    const store = new McpToolApprovalTransactions({ now: () => now, ttlMs: 100 });
    expect(store.resolve({ ...approvalRequest(), approvalMode: "never" })).toBe(true);
    expect(store.list("agent-a")).toEqual([]);
    const issued = store.resolve(approvalRequest()) as { confirmationText: string };
    for (const context of [
      { ...approvalContext(), agentId: "agent-b" },
      { ...approvalContext(), accountId: "secondary" },
      { ...approvalContext(), transport: "web" as const },
      { ...approvalContext(), conversationId: "private:2" },
      { ...approvalContext(), userId: 2 }
    ]) expect(store.confirm(issued.confirmationText, context)).toBe(false);
    now = 1_100;
    expect(store.confirm(issued.confirmationText, approvalContext())).toBe(false);
    expect(store.list("agent-a")).toEqual([]);
  });

  it("shows bounded structured arguments while redacting sensitive values and host paths", () => {
    const store = new McpToolApprovalTransactions({ now: () => 1_000 });
    const request = { ...approvalRequest(), arguments: {
      query: "read /Users/admin/private.txt and file:///etc/passwd",
      source: "file:///workbench/readme.md",
      nested: {
        accessToken: "sensitive-token",
        password: "sensitive-password",
        cookie: "sensitive-cookie",
        headers: {
          Authorization: "Basic dXNlcjpwYXNzd29yZA==",
          Cookie: "session=sensitive",
          "X-Api-Key": "plain-custom-secret",
          "X-Token": "plain-token"
        },
        headerValue: "Bearer header-value-token",
        custom: "sk-1234567890abcdef",
        github: "ghp_1234567890abcdefghijklmnop",
        privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        opaque: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_+/AbCdEfGhIjKlMnOp"
      },
      page: 1
    } };
    const required = store.resolve(request);
    const [pending] = store.list("agent-a");
    expect(pending).toMatchObject({
      agentId: "agent-a",
      argumentsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      arguments: {
        nested: {
          accessToken: "[REDACTED]",
          cookie: "[REDACTED]",
          custom: "[REDACTED]",
          github: "[REDACTED]",
          headers: {
            Authorization: "[REDACTED]",
            Cookie: "[REDACTED]",
            "X-Api-Key": "[REDACTED]",
            "X-Token": "[REDACTED]"
          },
          headerValue: "[REDACTED]",
          opaque: "[REDACTED]",
          password: "[REDACTED]",
          privateKey: "[REDACTED]"
        },
        page: 1,
        query: "read [HOST_PATH] and [HOST_PATH]",
        source: "file:///workbench/readme.md"
      },
      status: "pending"
    });
    expect(required).toMatchObject({ arguments: pending!.arguments, argumentsDigest: pending!.argumentsDigest });
    expect(JSON.stringify([required, pending])).not.toMatch(/sensitive-(?:token|password|cookie)|\/Users\/admin|\/etc\/passwd/u);

    const changed = store.resolve({
      ...request,
      arguments: { ...request.arguments, nested: { ...request.arguments.nested, accessToken: "changed-token" } },
      callId: "changed-secret"
    });
    expect(changed).toMatchObject({ approvalRequired: true });
    expect((changed as { approvalId: string }).approvalId).not.toBe((required as { approvalId: string }).approvalId);
    expect((changed as { argumentsDigest: string }).argumentsDigest).not.toBe(pending!.argumentsDigest);
  });

  it("fails closed before issuing a ticket when approval arguments exceed the smaller review budget", () => {
    const store = new McpToolApprovalTransactions({ now: () => 1_000, maxPending: 2 });
    expect(() => store.resolve({
      ...approvalRequest(),
      arguments: { text: "x".repeat(MCP_TOOL_APPROVAL_ARGUMENT_MAX_BYTES) }
    })).toThrow("MCP_TOOL_APPROVAL_ARGUMENTS_LIMIT");
    expect(store.list("agent-a")).toEqual([]);

    store.resolve({ ...approvalRequest(), arguments: { value: "a".repeat(4_000) } });
    store.resolve({ ...approvalRequest(), callId: "second", arguments: { value: "b".repeat(4_000) } });
    expect(JSON.stringify(store.list("agent-a")).length).toBeLessThan(MCP_TOOL_APPROVAL_ARGUMENT_MAX_BYTES);
    expect(() => store.resolve({
      ...approvalRequest(), callId: "third", arguments: { value: "c".repeat(4_000) }
    })).toThrow("MCP_TOOL_APPROVAL_QUEUE_FULL");
  });

  it("ignores untrusted annotations for approval identity and clears lifecycle state", () => {
    const store = new McpToolApprovalTransactions({ now: () => 1_000 });
    const request = approvalRequest();
    const first = store.resolve({ ...request, annotations: { destructiveHint: false } } as never);
    const second = store.resolve({
      ...request,
      callId: "annotation-retry",
      annotations: { destructiveHint: true }
    } as never);
    expect(second).toEqual(first);
    const [pending] = store.list("agent-a");
    expect(store.approve({ agentId: "agent-a", ticketId: pending!.id })).toEqual({ ok: true });
    expect(() => store.approve({ agentId: "agent-b", ticketId: pending!.id }))
      .toThrow("MCP_TOOL_APPROVAL_NOT_FOUND");
    expect(store.resolve({ ...request, callId: "retry" })).toBe(true);
    store.resolve({ ...approvalRequest(), conversationId: "private:2", callId: "next" });
    store.clearConversation("agent-a", "private:2");
    expect(store.list("agent-a")).toEqual([]);
  });
});

function approvalRequest() {
  return {
    agentId: "agent-a",
    accountId: "primary",
    transport: "onebot" as const,
    conversationId: "private:1",
    userId: 1,
    serverId: "server-a",
    toolName: "search",
    snapshotDigest: "a".repeat(64),
    catalogGeneration: 1,
    arguments: { query: "status", page: 1 },
    approvalMode: "always" as const,
    callId: "call-1"
  };
}

function approvalContext() {
  return {
    agentId: "agent-a",
    accountId: "primary",
    transport: "onebot" as const,
    conversationId: "private:1",
    userId: 1
  };
}
