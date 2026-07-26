// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  BashApprovalStore,
  buildBashAuditRequest,
  extractConfirmedBashApprovalId,
  parseBashAuditResult,
  runBashAudit
} from "../../services/tools/bashAudit.js";

const auditInput = {
  command: "cat report.txt",
  backend: "docker" as const,
  accessMode: "restricted" as const,
  strictMode: true,
  isAdmin: false,
  userRequest: "把聊天里的报告整理成压缩包"
};

describe("independent Bash audit", () => {
  it("builds a no-tools strict structured audit request", () => {
    const request = buildBashAuditRequest(auditInput);

    expect(request.tools).toEqual([]);
    expect(request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "bash_security_audit", strict: true }
    });
    expect(request.messages[0]?.content).toContain("Never execute it");
    expect(request.messages[0]?.content).toContain("isAdmin boolean is authoritative");
    expect(request.messages[0]?.content).toContain("directly instruct the Bot to enumerate");
    expect(request.messages[0]?.content).toContain("High-level business outcomes are allowed");
    expect(request.messages[0]?.content).toContain("allow only retrieval needed");
    expect(request.messages[1]?.content).toContain('"isAdmin":false');
    expect(request.messages[1]?.content).toContain('"userRequest":"把聊天里的报告整理成压缩包"');
    expect(buildBashAuditRequest({ ...auditInput, accessMode: "isolated" }).messages[0]?.content)
      .toContain("read-only access to the Native workbench projection");
    expect(request.messages[0]?.content).toContain("Skill and MCP configuration are exposed through SUNABOT_SKILLS and SUNABOT_MCP_CONFIG");
    const nativeRequest = buildBashAuditRequest({ ...auditInput, backend: "native", accessMode: "admin" });
    expect(nativeRequest.messages[0]?.content)
      .toContain("Native Bash may write both the current Agent Native workbench and the same Agent Docker workbench");
    expect(nativeRequest.messages[0]?.content)
      .toContain("native backend runs as the Sunabot runtime OS user after approval");
    expect(nativeRequest.messages[0]?.content)
      .toContain("outsideAccesses must list only absolute paths outside every declared workbench");
    expect(nativeRequest.messages[1]?.content).toContain('"docker":{"path":"$SUNABOT_DOCKER_WORKBENCH","access":"read-write"}');
    expect(request.messages[1]?.content).toContain('"native":{"path":"/workbench/native-workbench","access":"read-only"}');
  });

  it("parses the auditor response and rejects incomplete outside-path reports", async () => {
    const complete = vi.fn(async () => JSON.stringify({
      decision: "allow",
      risk: "low",
      outsideWorkbench: false,
      outsideAccesses: [],
      violations: [],
      summary: "workbench only"
    }));

    await expect(runBashAudit(auditInput, complete)).resolves.toMatchObject({ decision: "allow", risk: "low" });
    expect(complete).toHaveBeenCalledOnce();
    expect(() => parseBashAuditResult(JSON.stringify({
      decision: "confirm",
      risk: "medium",
      outsideWorkbench: true,
      outsideAccesses: [],
      violations: [],
      summary: "outside"
    }))).toThrow("BASH_AUDIT_INVALID");
  });

  it("binds approvals to one command and conversation and consumes them once", () => {
    let now = 1_000;
    const store = new BashApprovalStore(() => now, 60_000);
    const context = {
      backend: "native" as const,
      agentId: "plana",
      accountId: "qq-bot-a",
      transport: "onebot",
      conversationId: "private:admin",
      userId: "admin"
    };
    const frozenAccess = {
      path: "/fixture/file",
      access: "read" as const,
      identity: { device: "1", inode: "2", owner: "501", mode: "600" },
      pathChain: [
        { path: "/", device: "1", inode: "1", owner: "0", mode: "755" },
        { path: "/fixture", device: "1", inode: "3", owner: "501", mode: "700" },
        { path: "/fixture/file", device: "1", inode: "2", owner: "501", mode: "600" }
      ]
    };
    const approval = store.issue("cat /fixture/file", context, [frozenAccess]);

    expect(approval).toMatchObject({
      confirmationText: `/确认 Bash ${approval.id}`,
      accessSummary: "READ /fixture/file",
      accesses: [{ path: "/fixture/file", access: "read" }]
    });
    expect(approval.accesses[0]).not.toHaveProperty("identity");
    expect(store.consume(approval.id, "cat /other", context)).toBeUndefined();
    expect(store.consume(approval.id, "cat /fixture/file", { ...context, conversationId: "private:other" })).toBeUndefined();
    expect(store.consume(approval.id, "cat /fixture/file", { ...context, accountId: "qq-bot-b" })).toBeUndefined();
    expect(store.consume(approval.id, "cat /fixture/file", { ...context, transport: "web" })).toBeUndefined();
    expect(store.consume(approval.id, "cat /fixture/file", { ...context, backend: "docker" })).toBeUndefined();
    expect(store.consume(approval.id, "cat /fixture/file", context)).toEqual([frozenAccess]);
    expect(store.consume(approval.id, "cat /fixture/file", context)).toBeUndefined();

    const expired = store.issue("cat /fixture/expired", context, []);
    now += 60_001;
    expect(store.consume(expired.id, "cat /fixture/expired", context)).toBeUndefined();

    const invalid = store.issue.bind(store, "cat /fixture/invalid", {
      ...context,
      accountId: undefined
    } as unknown as typeof context, []);
    expect(invalid).toThrow("BASH_APPROVAL_CONTEXT_INVALID");
  });

  it("accepts only the exact administrator confirmation syntax", () => {
    const id = "bash-0123456789abcdef01234567";

    expect(extractConfirmedBashApprovalId(`/确认 Bash ${id}`)).toBe(id);
    expect(extractConfirmedBashApprovalId(`请 /确认 Bash ${id}`)).toBeUndefined();
    expect(extractConfirmedBashApprovalId(`/确认 Bash ${id} now`)).toBeUndefined();
  });

  it("shows every approved path with its exact read, write, or delete mode", () => {
    const store = new BashApprovalStore(() => 1_000, 60_000);
    const approval = store.issue("admin command", {
      backend: "native",
      agentId: "plana",
      accountId: "qq-bot-a",
      transport: "onebot",
      conversationId: "private:admin",
      userId: "admin"
    }, [
      { path: "/var/log/app.log", access: "read" },
      { path: "/opt/sunabot/output", access: "write" },
      { path: "/opt/sunabot/obsolete", access: "delete" }
    ]);

    expect(approval.accessSummary).toBe([
      "READ /var/log/app.log",
      "WRITE /opt/sunabot/output",
      "DELETE /opt/sunabot/obsolete"
    ].join("\n"));
  });
});
