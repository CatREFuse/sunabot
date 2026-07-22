import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditArchitecture,
  formatArchitectureResult
} from "../../tooling/quality/architecture/audit.mjs";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("architecture gate violation fixtures", () => {
  it("rejects every forbidden service dependency boundary", async () => {
    const root = await fixture({
      "services/orders/use.ts": [
        'import "../../adapters/db.js";',
        'import "../../src/admin/auth.js";',
        'import "../../deploy/config.js";',
        'import "../../tooling/task.js";'
      ].join("\n"),
      "adapters/db.ts": "export {};",
      "src/admin/auth.ts": "export {};",
      "deploy/config.ts": "export {};",
      "tooling/task.ts": "export {};"
    });

    const result = auditFixture(root, ["service-boundary"]);

    expect(result.failures).toHaveLength(4);
    expect(result.failures.join("\n")).toContain("adapters/db.ts");
    expect(result.failures.join("\n")).toContain("src/admin/auth.ts");
    expect(result.failures.join("\n")).toContain("deploy/config.ts");
    expect(result.failures.join("\n")).toContain("tooling/task.ts");
  });

  it("keeps contracts independent from services, adapters, src, Fastify, SQLite, and env", async () => {
    const root = await fixture({
      "packages/contracts/bad.ts": [
        'import "../../services/orders/public.js";',
        'import "../../adapters/db.js";',
        'import "../../src/types.js";',
        'import "fastify";',
        'import "node:sqlite";',
        'import "dotenv";',
        "export const secret = process.env.SECRET;"
      ].join("\n"),
      "services/orders/public.ts": "export {};",
      "adapters/db.ts": "export {};",
      "src/types.ts": "export {};"
    });

    const result = auditFixture(root, ["contracts-boundary"]);
    const failures = result.failures.join("\n");

    expect(result.failures).toHaveLength(7);
    expect(failures).toContain("services/orders/public.ts");
    expect(failures).toContain("adapters/db.ts");
    expect(failures).toContain("src/types.ts");
    expect(failures).toContain("Fastify");
    expect(failures).toContain("SQLite");
    expect(failures).toContain("environment loading");
    expect(failures).toContain("reads process environment");
  });

  it("keeps adapters and platform modules independent from the application composition root", async () => {
    const root = await fixture({
      "adapters/provider.ts": 'import type { Config } from "../src/types.js"; export type { Config };',
      "packages/platform/paths.ts": 'import { root } from "../../src/config.js"; export { root };',
      "src/types.ts": "export interface Config {}",
      "src/config.ts": "export const root = true;"
    });

    const result = auditFixture(root, ["layer-boundary"]);

    expect(result.failures).toHaveLength(2);
    expect(result.failures.join("\n")).toContain("adapters/provider.ts");
    expect(result.failures.join("\n")).toContain("packages/platform/paths.ts");
  });

  it("rejects executable cycles but ignores type-only cycles", async () => {
    const executableRoot = await fixture({
      "services/a/public.ts": 'import { b } from "../b/public.js"; export const a = b;',
      "services/b/public.ts": 'import { a } from "../a/public.js"; export const b = a;'
    });
    const typeOnlyRoot = await fixture({
      "services/a/public.ts": 'import type { B } from "../b/public.js"; export interface A { b?: B }',
      "services/b/public.ts": 'import type { A } from "../a/public.js"; export interface B { a?: A }'
    });

    const executable = auditFixture(executableRoot, ["executable-cycle"]);
    const typeOnly = auditFixture(typeOnlyRoot, ["executable-cycle"]);

    expect(executable.failures).toHaveLength(1);
    expect(executable.failures[0]).toContain("executable import cycle");
    expect(typeOnly.failures).toEqual([]);
  });

  it("rejects cross-service deep imports and accepts a public entry", async () => {
    const root = await fixture({
      "services/orders/use.ts": 'import { charge } from "../billing/internal.js"; export { charge };',
      "services/billing/internal.ts": "export const charge = true;",
      "services/billing/public.ts": 'export { charge } from "./internal.js";'
    });

    const deepImport = auditFixture(root, ["public-api"]);
    await fs.writeFile(
      path.join(root, "services/orders/use.ts"),
      'import { charge } from "../billing/public.js"; export { charge };'
    );
    const publicImport = auditFixture(root, ["public-api"]);

    expect(deepImport.failures).toHaveLength(1);
    expect(deepImport.failures[0]).toContain("cross-service imports must use public.ts or index.ts");
    expect(publicImport.failures).toEqual([]);
  });

  it("rejects durable JSON sinks without a versioned encode/decode codec", async () => {
    const root = await fixture({
      "services/sessions/store.ts": [
        "const insert = `INSERT INTO session_events (payload_json) VALUES (?)`;",
        "export const write = (value: unknown) => JSON.stringify(value);",
        "export const read = (value: string) => JSON.parse(value);"
      ].join("\n")
    });

    const result = auditFixture(root, ["durable-codec"]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("session-event JSON");
    expect(result.failures[0]).toContain("versioned contract codec");
  });

  it("accepts a durable sink only when a versioned contract codec is imported and used both ways", async () => {
    const root = await fixture({
      "packages/contracts/session/eventCodec.ts": [
        "export const sessionEventCodec = {",
        "  schemaVersion: 1,",
        "  encode(value: unknown) { return { schemaVersion: 1, payload: value }; },",
        "  decode(value: unknown) { return value; }",
        "};"
      ].join("\n"),
      "services/sessions/store.ts": [
        'import { sessionEventCodec } from "../../packages/contracts/session/eventCodec.js";',
        "const insert = `INSERT INTO session_events (payload_json) VALUES (?)`;",
        "export const write = (value: unknown) => sessionEventCodec.encode(value);",
        "export const read = (value: unknown) => sessionEventCodec.decode(value);"
      ].join("\n")
    });

    expect(auditFixture(root, ["durable-codec"]).failures).toEqual([]);
  });

  it("rejects ToolRegistry entries when definition and execution are not paired", async () => {
    const root = await fixture({
      "services/tools/toolRegistry.ts": [
        "const catalog = [",
        '  { name: "definition_only", definition: () => ({}) },',
        '  { name: "execution_only", execution: "inline" },',
        '  { name: "external_ok", execution: "external" }',
        "];"
      ].join("\n")
    });

    const result = auditFixture(root, ["tool-registry"]);
    const failures = result.failures.join("\n");

    expect(result.failures).toHaveLength(2);
    expect(failures).toContain("definition_only has a model definition without execution");
    expect(failures).toContain("execution_only declares inline execution without a model definition");
  });

  it("rejects files and classes above the default budgets", async () => {
    const fileRoot = await fixture({
      "services/large/file.ts": Array.from({ length: 801 }, (_, index) => `// ${index}`).join("\n")
    });
    const classRoot = await fixture({
      "services/large/class.ts": [
        "export class Giant {",
        ...Array.from({ length: 500 }, (_, index) => `  // ${index}`),
        "}"
      ].join("\n")
    });

    const fileResult = auditFixture(fileRoot, ["size-budget"]);
    const classResult = auditFixture(classRoot, ["size-budget"]);

    expect(fileResult.failures).toHaveLength(1);
    expect(fileResult.failures[0]).toContain("file target is <800");
    expect(classResult.failures).toHaveLength(1);
    expect(classResult.failures[0]).toContain("class target is <500");
  });

  it("prints active debt and fails stale allowances instead of silently skipping", async () => {
    const root = await fixture({
      "services/orders/use.ts": 'import { charge } from "../billing/internal.js"; export { charge };',
      "services/billing/internal.ts": "export const charge = true;"
    });
    const allowance = {
      id: "fixture-deep-import",
      rule: "public-api",
      source: "services/orders/use.ts",
      target: "services/billing/internal.ts",
      reason: "Fixture migration debt.",
      tracking: "FIXTURE-001"
    };

    const allowed = auditFixture(root, ["public-api"], [allowance]);
    const stale = auditFixture(root, ["service-boundary"], [allowance]);
    const output = formatArchitectureResult(allowed);

    expect(allowed.failures).toEqual([]);
    expect(allowed.debts).toHaveLength(1);
    expect(output).toContain("Active architecture debt");
    expect(output).toContain("tracking=FIXTURE-001");
    expect(output).toContain("reason=Fixture migration debt.");
    expect(stale.failures).toEqual([]);

    const staleForEnabledRule = auditArchitecture(root, {
      rules: ["public-api"],
      debtAllowances: [{ ...allowance, target: "services/billing/removed.ts" }]
    });
    expect(staleForEnabledRule.failures).toContain(
      "stale architecture debt allowance fixture-deep-import; remove or update the explicit allowance"
    );
  });
});

function auditFixture(
  root: string,
  rules: string[],
  debtAllowances: Array<Record<string, unknown>> = []
) {
  return auditArchitecture(root, { rules, debtAllowances });
}

async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-architecture-"));
  fixtureRoots.push(root);
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }));
  return root;
}
