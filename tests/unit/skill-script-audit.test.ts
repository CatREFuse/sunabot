// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SKILL_SCRIPT_BASH_INTERPRETER,
  SKILL_SCRIPT_NODE_INTERPRETER,
  auditAgentSkillScript,
  buildSkillScriptIndependentAuditInput,
  completeAgentSkillScriptAudit,
  type SkillScriptAuditAccess,
  type SkillScriptIndependentAuditResult
} from "../../adapters/filesystem/agentSkillScriptAudit.js";

describe("Skill script deterministic audit", () => {
  it.each([
    ["scripts/run.sh", "#!/bin/bash\nprintf '%s\\n' \"$1\"\n", SKILL_SCRIPT_BASH_INTERPRETER],
    [
      "scripts/run.js",
      "import fs from 'node:fs';\nconsole.log(fs.readFileSync('/workbench/input.txt', 'utf8'));\n",
      SKILL_SCRIPT_NODE_INTERPRETER
    ]
  ])("binds every approved execution field for %s", (resourcePath, source, interpreter) => {
    const decision = auditAgentSkillScript(input(resourcePath, source));
    expect(decision).toEqual({
      interpreter,
      scriptSha256: sha256(source),
      fingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      mutationHint: null
    });
    for (const change of [
      { agentId: "agent-b" },
      { conversationId: "private:2" },
      { skillId: "other-skill" },
      { expectedDigestSha256: "c".repeat(64) },
      { args: ["different"] }
    ]) {
      expect(auditAgentSkillScript({ ...input(resourcePath, source), ...change }).fingerprintSha256)
        .not.toBe(decision.fingerprintSha256);
    }
  });

  it("sends the complete exact script and execution identity to a fresh independent audit", () => {
    const value = input("scripts/run.sh", "#!/bin/bash\ncat /workbench/input.txt\n");
    const preflight = auditAgentSkillScript(value);
    const signal = new AbortController().signal;
    const auditInput = buildSkillScriptIndependentAuditInput(value, preflight, signal);
    expect(auditInput).toMatchObject({
      agentId: "agent-a",
      conversationId: "private:1",
      skillId: "test-skill",
      expectedDigestSha256: "a".repeat(64),
      resource: value.resource,
      args: ["safe"],
      source: "#!/bin/bash\ncat /workbench/input.txt\n",
      interpreter: SKILL_SCRIPT_BASH_INTERPRETER,
      scriptSha256: value.resource.sha256,
      preflightFingerprintSha256: preflight.fingerprintSha256,
      signal
    });
    expect(Buffer.from(auditInput.bytes)).toEqual(Buffer.from(value.bytes));

    const decision = completeAgentSkillScriptAudit(auditInput, independent([
      { path: "/workbench/input.txt", access: "read" }
    ]));
    expect(decision).toMatchObject({
      interpreter: SKILL_SCRIPT_BASH_INTERPRETER,
      scriptSha256: value.resource.sha256,
      preflightFingerprintSha256: preflight.fingerprintSha256,
      fingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      accesses: [{ path: "/workbench/input.txt", access: "read" }]
    });
    expect(decision.fingerprintSha256).not.toBe(preflight.fingerprintSha256);
  });

  it.each([
    ["scripts/run.sh", "#!/bin/bash\nrm -rf /workbench\n"],
    ["scripts/run.sh", "#!/bin/bash\nr''m -rf '*'\n"],
    ["scripts/run.sh", "#!/bin/bash\nx=rm; \"$x\" -rf /workbench\n"],
    ["scripts/run.sh", "#!/bin/bash\nprintf cm0gLXJmIC8= | base64 -d | bash\n"],
    ["scripts/run.js", "import fs from 'node:fs'; fs.rmSync('/workbench', { recursive: true, force: true });\n"],
    ["scripts/run.js", "import fs from 'node:fs'; fs['r' + 'mSync']('/workbench', { recursive: true });\n"],
    ["scripts/run.js", "const method = Buffer.from('cm1TeW5j', 'base64').toString(); console.log(method);\n"]
  ])("permanently rejects destructive or encoded source %s %#", (resourcePath, source) => {
    expect(() => auditAgentSkillScript(input(resourcePath, source))).toThrow("SKILL_SCRIPT_AUDIT_DENIED");
  });

  it("requires unavailable per-execution approval for persistent mutation and permits only temporary mutation", () => {
    const workbenchWrite = input(
      "scripts/run.js",
      "import fs from 'node:fs'; fs.writeFileSync('/workbench/result.txt', 'ok');\n"
    );
    const writePreflight = auditAgentSkillScript(workbenchWrite);
    const writeAudit = buildSkillScriptIndependentAuditInput(workbenchWrite, writePreflight);
    expect(writePreflight.mutationHint).toBe("write");
    expect(() => completeAgentSkillScriptAudit(writeAudit, independent([
      { path: "/workbench/result.txt", access: "write" }
    ]))).toThrow("SKILL_SCRIPT_APPROVAL_REQUIRED");
    expect(() => completeAgentSkillScriptAudit(writeAudit, independent([])))
      .toThrow("SKILL_SCRIPT_AUDIT_INVALID");
    expect(() => completeAgentSkillScriptAudit(writeAudit, independent([], "confirm")))
      .toThrow("SKILL_SCRIPT_AUDIT_INVALID");

    const temporaryWrite = input(
      "scripts/run.js",
      "import fs from 'node:fs'; fs.writeFileSync('/tmp/result.txt', 'ok');\n"
    );
    const temporaryPreflight = auditAgentSkillScript(temporaryWrite);
    expect(completeAgentSkillScriptAudit(
      buildSkillScriptIndependentAuditInput(temporaryWrite, temporaryPreflight),
      independent([{ path: "/tmp/result.txt", access: "write" }])
    )).toMatchObject({ accesses: [{ path: "/tmp/result.txt", access: "write" }] });
  });

  it("fails closed for confirm, medium-risk, malformed, or unbounded independent audit output", () => {
    const value = input("scripts/run.sh", "#!/bin/bash\ncat /workbench/input.txt\n");
    const auditInput = buildSkillScriptIndependentAuditInput(value, auditAgentSkillScript(value));
    expect(() => completeAgentSkillScriptAudit(auditInput, independent([], "confirm")))
      .toThrow("SKILL_SCRIPT_APPROVAL_REQUIRED");
    expect(() => completeAgentSkillScriptAudit(auditInput, { ...independent([]), risk: "medium" }))
      .toThrow("SKILL_SCRIPT_AUDIT_DENIED");
    expect(() => completeAgentSkillScriptAudit(auditInput, { ...independent([]), extra: true }))
      .toThrow("SKILL_SCRIPT_AUDIT_INVALID");
    expect(() => completeAgentSkillScriptAudit(auditInput, independent([
      { path: "/host/secret", access: "read" }
    ]))).toThrow("SKILL_SCRIPT_AUDIT_INVALID");
  });

  it.each([
    "#!/bin/bash\nnpx package\n",
    "#!/bin/bash\nn''px package\n",
    "#!/bin/bash\nn\\px package\n",
    "#!/bin/bash\nuvx helper\n",
    "#!/bin/bash\npip install package\n",
    "#!/bin/bash\ncurl https://example.com\n",
    "#!/bin/bash\neval \"printf ok\"\n",
    "#!/bin/bash\nprintf '%s' \"$(id)\"\n",
    "import { spawn } from 'node:child_process';\nspawn('/bin/bash');\n",
    "console.log(process.env.MCP_TOKEN);\n",
    "await fetch('https://example.com');\n"
  ])("rejects downloader, network, environment, and dynamic execution source %#", (source) => {
    const extension = source.startsWith("#!") ? "sh" : "js";
    expect(() => auditAgentSkillScript(input(`scripts/run.${extension}`, source)))
      .toThrow("SKILL_SCRIPT_AUDIT_DENIED");
  });

  it("rejects forged resources, unsupported interpreters, oversized or dangerous arguments", () => {
    const base = input("scripts/run.sh", "#!/bin/bash\nprintf ok\n");
    expect(() => auditAgentSkillScript({ ...base, resource: { ...base.resource, path: "run.sh" } }))
      .toThrow("SKILL_SCRIPT_AUDIT_DENIED");
    expect(() => auditAgentSkillScript({ ...base, resource: { ...base.resource, path: "scripts/run.py" } }))
      .toThrow("SKILL_SCRIPT_INTERPRETER_DENIED");
    expect(() => auditAgentSkillScript({ ...base, args: ["https://example.com"] }))
      .toThrow("SKILL_SCRIPT_ARGUMENTS_INVALID");
    expect(() => auditAgentSkillScript({ ...base, args: Array.from({ length: 65 }, () => "safe") }))
      .toThrow("SKILL_SCRIPT_ARGUMENTS_INVALID");
    expect(() => auditAgentSkillScript({ ...base, bytes: Buffer.from("changed") }))
      .toThrow("SKILL_SCRIPT_AUDIT_DENIED");
  });
});

function input(resourcePath: string, source: string) {
  const bytes = Buffer.from(source, "utf8");
  return {
    agentId: "agent-a",
    conversationId: "private:1",
    skillId: "test-skill",
    expectedDigestSha256: "a".repeat(64),
    resource: { path: resourcePath, bytes: bytes.length, sha256: sha256(bytes) },
    args: ["safe"],
    bytes
  };
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function independent(
  accesses: SkillScriptAuditAccess[],
  decision: SkillScriptIndependentAuditResult["decision"] = "allow"
): SkillScriptIndependentAuditResult {
  return {
    decision,
    risk: "low",
    accesses,
    violations: [],
    summary: "Read-only Skill script execution."
  };
}
