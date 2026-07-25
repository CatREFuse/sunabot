// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySelfieReferencesMigration,
  planSelfieReferencesMigration,
  rollbackSelfieReferencesMigration,
  verifySelfieReferencesMigration
} from "../../tooling/migrations/migrate-selfie-references-jsonl.mjs";

let root = "";
let workspace = "";
let selfieDirectory = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-jsonl-migration-"));
  workspace = path.join(root, "workspace");
  selfieDirectory = path.join(workspace, "business", "agents", "plana", "selfie");
  await fs.mkdir(selfieDirectory, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("selfie reference JSONL migration", () => {
  it("plans without writes, backs up, applies idempotently, verifies and rolls back", async () => {
    const reference = fixtureReference("常服");
    await writeLegacy([reference]);

    const plan = await planSelfieReferencesMigration({ workspace });

    expect(plan).toMatchObject({
      ok: true,
      command: "plan",
      changesRequired: true,
      agents: [{ agentId: "plana", state: "legacy", references: 1 }]
    });
    await expect(fs.lstat(path.join(selfieDirectory, "references.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(workspace, "backups")))
      .rejects.toMatchObject({ code: "ENOENT" });

    await expect(applySelfieReferencesMigration({ workspace, quiesced: false }))
      .rejects.toMatchObject({ code: "QUIESCED_REQUIRED" });

    const applied = await applySelfieReferencesMigration({
      workspace,
      quiesced: true,
      now: new Date("2026-07-25T10:00:00.000Z"),
      assertStopped: async () => undefined
    });

    expect(applied).toMatchObject({
      ok: true,
      command: "apply",
      migrated: true,
      backup: "backups/selfie-references-jsonl-v1-2026-07-25T10-00-00-000Z",
      agents: [{ agentId: "plana", state: "jsonl", references: 1 }]
    });
    await expect(fs.lstat(path.join(selfieDirectory, "references.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJsonl()).toEqual([reference]);
    await expect(verifySelfieReferencesMigration({ workspace })).resolves.toMatchObject({ ok: true });

    await expect(applySelfieReferencesMigration({
      workspace,
      quiesced: true,
      assertStopped: async () => undefined
    })).resolves.toMatchObject({ migrated: false });

    const rolledBack = await rollbackSelfieReferencesMigration({
      workspace,
      backup: applied.backup,
      quiesced: true,
      assertStopped: async () => undefined
    });
    expect(rolledBack).toMatchObject({
      ok: true,
      command: "rollback",
      restoredAgents: ["plana"]
    });
    await expect(fs.lstat(path.join(selfieDirectory, "references.jsonl")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(path.join(selfieDirectory, "references.json"), "utf8")))
      .toEqual({ schemaVersion: 1, references: [reference] });
  });

  it("accepts an interrupted equivalent pair and removes only the legacy copy", async () => {
    const reference = fixtureReference("女仆装");
    await writeLegacy([reference]);
    await writeJsonl([reference]);

    await expect(planSelfieReferencesMigration({ workspace })).resolves.toMatchObject({
      changesRequired: true,
      agents: [{ agentId: "plana", state: "both" }]
    });
    await expect(applySelfieReferencesMigration({
      workspace,
      quiesced: true,
      now: new Date("2026-07-25T11:00:00.000Z"),
      assertStopped: async () => undefined
    })).resolves.toMatchObject({ migrated: true });
    await expect(fs.lstat(path.join(selfieDirectory, "references.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJsonl()).toEqual([reference]);
  });

  it("fails closed when the new and legacy catalogs conflict", async () => {
    await writeLegacy([fixtureReference("常服")]);
    await writeJsonl([fixtureReference("泳装")]);

    await expect(planSelfieReferencesMigration({ workspace })).rejects.toMatchObject({
      code: "SELFIE_REFERENCE_MANIFEST_CONFLICT"
    });
    await expect(fs.lstat(path.join(workspace, "backups")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses rollback after the published JSONL catalog changes", async () => {
    await writeLegacy([fixtureReference("常服")]);
    const applied = await applySelfieReferencesMigration({
      workspace,
      quiesced: true,
      now: new Date("2026-07-25T12:00:00.000Z"),
      assertStopped: async () => undefined
    });
    await writeJsonl([fixtureReference("新备注")]);

    await expect(rollbackSelfieReferencesMigration({
      workspace,
      backup: applied.backup,
      quiesced: true,
      assertStopped: async () => undefined
    })).rejects.toMatchObject({ code: "SELFIE_REFERENCE_ROLLBACK_CONFLICT" });
    await expect(fs.lstat(path.join(selfieDirectory, "references.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJsonl()).toEqual([fixtureReference("新备注")]);
  });

  it("rejects symbolic-link Agent directories before reading manifests", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(path.join(workspace, "business", "agents", "arona"), { recursive: true });
    await fs.rm(path.join(workspace, "business", "agents", "arona"), { recursive: true });
    await fs.symlink(outside, path.join(workspace, "business", "agents", "arona"), "dir");

    await expect(planSelfieReferencesMigration({ workspace })).rejects.toMatchObject({
      code: "SELFIE_REFERENCE_PATH_INVALID"
    });
  });
});

function fixtureReference(note: string) {
  return {
    id: crypto.createHash("sha256").update(note).digest("hex"),
    fileName: `${note}.png`,
    note
  };
}

async function writeLegacy(references: ReturnType<typeof fixtureReference>[]) {
  await fs.writeFile(
    path.join(selfieDirectory, "references.json"),
    `${JSON.stringify({ schemaVersion: 1, references }, null, 2)}\n`
  );
}

async function writeJsonl(references: ReturnType<typeof fixtureReference>[]) {
  await fs.writeFile(
    path.join(selfieDirectory, "references.jsonl"),
    references.length
      ? `${references.map((reference) => JSON.stringify({ schemaVersion: 1, ...reference })).join("\n")}\n`
      : ""
  );
}

async function readJsonl() {
  const content = await fs.readFile(path.join(selfieDirectory, "references.jsonl"), "utf8");
  return content.trimEnd().split("\n").filter(Boolean).map((line) => {
    const { schemaVersion, ...reference } = JSON.parse(line);
    expect(schemaVersion).toBe(1);
    return reference;
  });
}
