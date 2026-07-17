// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Skill script dependency boundary", () => {
  it("keeps the concrete script sandbox private to the executor module", async () => {
    const sourceRoots = ["adapters", "apps", "packages", "services", "src"];
    const consumers: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of await typescriptFiles(path.join(repositoryRoot, sourceRoot))) {
        const relative = path.relative(repositoryRoot, file).replaceAll(path.sep, "/");
        const source = await fs.readFile(file, "utf8");
        if (source.includes("agentSkillScriptSandbox.js")) consumers.push(relative);
      }
    }
    expect(consumers).toEqual(["adapters/filesystem/agentSkillScriptExecutor.ts"]);
  });

  it("does not expose script implementations through the filesystem public entry", async () => {
    const source = await fs.readFile(path.join(repositoryRoot, "adapters/filesystem/public.ts"), "utf8");
    expect(source.trim()).toBe("export {};");
  });
});

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(candidate);
  }
  return files.sort();
}
