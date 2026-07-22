import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  orderPromptMigrations,
  runPromptMigrationRegistry,
  type PromptMigrationDefinition
} from "../../services/agent/promptMigrationRegistry.js";
import { defaultConfig } from "../../src/config.js";
import type { AppConfig } from "../../src/types.js";

let root = "";
let config: AppConfig;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prompt-registry-"));
  config = defaultConfig();
  config.persona.systemPromptWorkspace = path.join(root, "system");
  config.persona.agentWorkspace = path.join(root, "persona");
  await Promise.all([
    fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true }),
    fs.mkdir(config.persona.agentWorkspace, { recursive: true })
  ]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("prompt migration registry", () => {
  it("orders dependencies, backs up input, verifies output and commits one journal", async () => {
    const filePath = path.join(config.persona.systemPromptWorkspace, "reply.json");
    await fs.writeFile(filePath, "before\n", "utf8");
    const calls: string[] = [];
    const definitions = [
      definition("second-v1", async () => {
        calls.push("second");
        await fs.appendFile(filePath, "second\n", "utf8");
      }, ["first-v1"]),
      definition("first-v1", async () => {
        calls.push("first");
        await fs.appendFile(filePath, "first\n", "utf8");
      })
    ];

    const report = await runPromptMigrationRegistry(config, definitions);

    expect(calls).toEqual(["first", "second"]);
    expect(report).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "first-v1", status: "completed", changed: true }),
      expect.objectContaining({ id: "second-v1", status: "completed", changed: true })
    ]));
    const journal = JSON.parse(await fs.readFile(
      path.join(config.persona.systemPromptWorkspace, ".sunabot-prompt-migrations.json"),
      "utf8"
    ));
    expect(journal.entries).toMatchObject({
      "first-v1": { status: "completed", inputDigest: expect.any(String), outputDigest: expect.any(String) },
      "second-v1": { status: "completed", inputDigest: expect.any(String), outputDigest: expect.any(String) }
    });
    const backups = await listFiles(path.join(config.persona.systemPromptWorkspace, ".prompt-migration-backups"));
    expect(backups).toHaveLength(2);

    await runPromptMigrationRegistry(config, definitions);
    expect(calls).toEqual(["first", "second"]);
  });

  it("leaves started state after a crash and completes idempotently on retry", async () => {
    const filePath = path.join(config.persona.systemPromptWorkspace, "reply.json");
    await fs.writeFile(filePath, "before\n", "utf8");
    const failed = definition("recover-v1", async () => {
      await fs.writeFile(filePath, "partial\n", "utf8");
      throw new Error("simulated crash");
    });

    await expect(runPromptMigrationRegistry(config, [failed])).rejects.toThrow("simulated crash");
    const started = JSON.parse(await fs.readFile(
      path.join(config.persona.systemPromptWorkspace, ".sunabot-prompt-migrations.json"),
      "utf8"
    ));
    expect(started.entries["recover-v1"].status).toBe("started");

    const recovered = definition("recover-v1", async () => {
      await fs.writeFile(filePath, "complete\n", "utf8");
    });
    await runPromptMigrationRegistry(config, [recovered]);
    const completed = JSON.parse(await fs.readFile(
      path.join(config.persona.systemPromptWorkspace, ".sunabot-prompt-migrations.json"),
      "utf8"
    ));
    expect(completed.entries["recover-v1"]).toMatchObject({ status: "completed", outputDigest: expect.any(String) });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("complete\n");
  });

  it("reports a dry run without writing a journal or invoking transforms", async () => {
    const run = vi.fn(async () => undefined);
    const report = await runPromptMigrationRegistry(config, [definition("dry-v1", run)], { dryRun: true });

    expect(report).toEqual([expect.objectContaining({ id: "dry-v1", status: "pending", changed: false })]);
    expect(run).not.toHaveBeenCalled();
    await expect(fs.access(path.join(config.persona.systemPromptWorkspace, ".sunabot-prompt-migrations.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate ids, missing dependencies and cycles", () => {
    const first = definition("first-v1", async () => undefined);
    expect(() => orderPromptMigrations([first, first])).toThrow("Duplicate");
    expect(() => orderPromptMigrations([definition("first-v1", async () => undefined, ["missing-v1"])]))
      .toThrow("Missing");
    expect(() => orderPromptMigrations([
      definition("first-v1", async () => undefined, ["second-v1"]),
      definition("second-v1", async () => undefined, ["first-v1"])
    ])).toThrow("cycle");
  });
});

function definition(
  id: string,
  run: () => Promise<unknown>,
  dependencies: readonly string[] = []
): PromptMigrationDefinition {
  return {
    id,
    scope: "system",
    files: ["reply.json"],
    dependencies,
    backupPolicy: "once",
    run,
    verify: async () => undefined
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }));
  return nested.flat();
}
