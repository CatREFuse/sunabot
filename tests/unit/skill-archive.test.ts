// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSkillArchive,
  inspectSkillDirectory
} from "../../adapters/filesystem/skillArchive.js";
import { pinDirectoryIdentity } from "../../adapters/filesystem/agentExtensionSecureFs.js";
import {
  makeStoredZip,
  openAiSkillMetadata,
  skillMarkdown,
  type TestZipEntry
} from "./agent-extension-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("Skill archive", () => {
  it("extracts a root package and a single matching wrapper with stable evidence", async () => {
    const staging = await temporaryDirectory();
    const root = await extractSkillArchive({
      archive: makeStoredZip([
        {
          name: "SKILL.md",
          content: skillMarkdown(
            "test-skill",
            undefined,
            "Read references/usage.md and https://docs.example.test when needed.",
            "license: MIT\ncompatibility: Requires git.\nmetadata:\n  author: Sunabot\nallowed-tools: Read Bash(git:*)"
          )
        },
        { name: "references/usage.md", content: "Usage details.\n" },
        { name: "scripts/run.sh", content: "#!/bin/sh\n" },
        { name: "agents/openai.yaml", content: openAiSkillMetadata() }
      ]),
      stagingRoot: staging
    });
    expect(root.evidence).toMatchObject({
      name: "test-skill",
      license: "MIT",
      compatibility: "Requires git.",
      metadata: { author: "Sunabot" },
      allowedTools: ["Bash(git:*)", "Read"],
      fileCount: 4,
      riskEvidence: {
        reviewStatus: "unreviewed",
        reviewedDigestSha256: null,
        classification: "script-bearing",
        hasScripts: true,
        hasExternalUrls: true,
        declaredFileAccess: ["read", "shell"],
        allowImplicitInvocation: false,
        mcpDependencies: [{ id: "github-mcp" }]
      }
    });
    expect(root.evidence.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(inspectSkillDirectory(root.packageRoot)).resolves.toEqual(root.evidence);

    const wrapped = await extractSkillArchive({
      archive: makeStoredZip([
        { name: "wrapped-skill/SKILL.md", content: skillMarkdown("wrapped-skill") },
        { name: "wrapped-skill/assets/icon.txt", content: "asset\n" }
      ]),
      stagingRoot: staging
    });
    expect(wrapped.packageRoot).toBe(wrapped.container);
    expect(await fs.readFile(path.join(wrapped.packageRoot, "SKILL.md"), "utf8"))
      .toContain("name: wrapped-skill");
    expect(wrapped.evidence.name).toBe("wrapped-skill");
  });

  it.each([
    ["path traversal", { name: "../outside.txt", content: "outside" }],
    ["absolute path", { name: "/tmp/outside.txt", content: "outside" }],
    ["Windows drive path", { name: "C:/outside.txt", content: "outside" }],
    ["backslash path", { name: "references\\outside.md", content: "outside" }],
    ["NUL path", { name: "bad\0name", content: "outside" }],
    ["symlink", { name: "linked", content: "target", unixMode: 0o120777 }],
    ["FIFO", { name: "pipe", content: "", unixMode: 0o010644 }],
    ["device", { name: "device", content: "", unixMode: 0o020644 }]
  ] satisfies Array<[string, TestZipEntry]>)("rejects %s entries without writing outside staging", async (_label, malicious) => {
    const staging = await temporaryDirectory();
    const outside = path.join(path.dirname(staging), "outside.txt");
    await expect(extractSkillArchive({
      archive: makeStoredZip([
        { name: "SKILL.md", content: skillMarkdown() },
        malicious
      ]),
      stagingRoot: staging
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fs.access(outside)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(staging)).filter((entry) => entry.startsWith(".skill-stage-"))).toEqual([]);
  });

  it("rejects duplicate/case-folded paths and entry, file, total and compression-ratio limits", async () => {
    const staging = await temporaryDirectory();
    await expect(extractSkillArchive({
      archive: makeStoredZip([
        { name: "SKILL.md", content: skillMarkdown() },
        { name: "Readme.md", content: "a" },
        { name: "README.md", content: "b" }
      ]),
      stagingRoot: staging
    })).rejects.toMatchObject({ code: "SKILL_ARCHIVE_DUPLICATE_PATH" });

    const archive = makeStoredZip([
      { name: "SKILL.md", content: skillMarkdown() },
      { name: "one.txt", content: "1234" }
    ]);
    await expect(extractSkillArchive({ archive, stagingRoot: staging, limits: { maxEntries: 1 } }))
      .rejects.toMatchObject({ code: "SKILL_ARCHIVE_ENTRY_LIMIT" });
    await expect(extractSkillArchive({ archive, stagingRoot: staging, limits: { maxFileBytes: 8 } }))
      .rejects.toMatchObject({ code: "SKILL_ARCHIVE_FILE_LIMIT" });
    await expect(extractSkillArchive({ archive, stagingRoot: staging, limits: { maxTotalBytes: 16 } }))
      .rejects.toMatchObject({ code: "SKILL_ARCHIVE_TOTAL_LIMIT" });
  });

  it("rejects wrapper/name mismatch, unknown frontmatter and non-direct references", async () => {
    const staging = await temporaryDirectory();
    await expect(extractSkillArchive({
      archive: makeStoredZip([{ name: "wrong-folder/SKILL.md", content: skillMarkdown("right-name") }]),
      stagingRoot: staging
    })).rejects.toMatchObject({ code: "SKILL_FOLDER_NAME_MISMATCH" });

    await expect(extractSkillArchive({
      archive: makeStoredZip([{
        name: "SKILL.md",
        content: "---\nname: test-skill\ndescription: Handles tests when asked.\nunknown: value\n---\nBody\n"
      }]),
      stagingRoot: staging
    })).rejects.toMatchObject({ code: "SKILL_FRONTMATTER_INVALID" });

    await expect(extractSkillArchive({
      archive: makeStoredZip([
        { name: "SKILL.md", content: skillMarkdown() },
        { name: "references/hidden.md", content: "Hidden\n" }
      ]),
      stagingRoot: staging
    })).rejects.toMatchObject({ code: "SKILL_REFERENCE_UNDISCLOSED" });
    await expect(extractSkillArchive({
      archive: makeStoredZip([
        { name: "SKILL.md", content: skillMarkdown("test-skill", undefined, "Read references/nested/hidden.md.") },
        { name: "references/nested/hidden.md", content: "Hidden\n" }
      ]),
      stagingRoot: staging
    })).rejects.toMatchObject({ code: "SKILL_REFERENCE_DEPTH_INVALID" });
  });

  it("fails closed when an installed tree is changed into a hardlink or symlink", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, "SKILL.md"), skillMarkdown());
    await fs.writeFile(path.join(directory, "source.txt"), "source\n");
    await fs.link(path.join(directory, "source.txt"), path.join(directory, "hardlink.txt"));
    await expect(inspectSkillDirectory(directory)).rejects.toMatchObject({
      code: "SKILL_PACKAGE_SPECIAL_FILE_REJECTED"
    });
    await fs.rm(path.join(directory, "hardlink.txt"));
    await fs.symlink(path.join(directory, "source.txt"), path.join(directory, "linked.txt"));
    await expect(inspectSkillDirectory(directory)).rejects.toMatchObject({ code: "SKILL_PACKAGE_LINK_REJECTED" });
  });

  it("rejects leaf and intermediate-directory swaps before reading the replacement", async () => {
    const leafPackage = await temporaryDirectory();
    const leafOutside = await temporaryDirectory();
    await fs.writeFile(path.join(leafPackage, "SKILL.md"), skillMarkdown());
    await fs.writeFile(path.join(leafPackage, "asset.txt"), "safe\n");
    await fs.writeFile(path.join(leafOutside, "secret.txt"), "outside-secret\n");
    await expect(inspectSkillDirectory(leafPackage, {}, {
      async beforeFileOpen(absolute, relative) {
        if (relative !== "asset.txt") return;
        await fs.rm(absolute);
        await fs.symlink(path.join(leafOutside, "secret.txt"), absolute);
      }
    })).rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });

    const directoryPackage = await temporaryDirectory();
    const directoryOutside = await temporaryDirectory();
    await fs.writeFile(
      path.join(directoryPackage, "SKILL.md"),
      skillMarkdown("test-skill", undefined, "Read references/usage.md when needed.")
    );
    await fs.mkdir(path.join(directoryPackage, "references"));
    await fs.writeFile(path.join(directoryPackage, "references/usage.md"), "safe\n");
    await fs.writeFile(path.join(directoryOutside, "usage.md"), "outside-secret\n");
    await expect(inspectSkillDirectory(directoryPackage, {}, {
      async beforeDirectoryRead(absolute, relative) {
        if (relative !== "references") return;
        await fs.rm(absolute, { recursive: true });
        await fs.symlink(directoryOutside, absolute);
      }
    })).rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });
  });

  it.each(["swap", "swap-back"])("blocks staging container %s races before any outside write", async (mode) => {
    const staging = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "unchanged\n");
    let attacked = false;
    let moved = "";
    let container = "";
    try {
      await expect(extractSkillArchive({
        archive: makeStoredZip([{ name: "SKILL.md", content: skillMarkdown() }]),
        stagingRoot: staging,
        hooks: {
          async beforeStageOperation(operation, absolute) {
            if (attacked || operation !== "write") return;
            attacked = true;
            container = path.dirname(absolute);
            moved = `${container}.moved`;
            await fs.rename(container, moved);
            if (mode === "swap") {
              await fs.symlink(outside, container);
            } else {
              await fs.mkdir(container, { mode: 0o700 });
              await fs.rm(container, { recursive: true });
              await fs.rename(moved, container);
              moved = "";
            }
          }
        }
      })).rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
      expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
    } finally {
      if (container && await exists(container) && (await fs.lstat(container)).isSymbolicLink()) await fs.unlink(container);
      if (moved && await exists(moved)) await fs.rename(moved, container);
    }
  });

  it.each(["swap", "swap-back"])("blocks staging intermediate-directory %s races", async (mode) => {
    const staging = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "unchanged\n");
    let attacked = false;
    let moved = "";
    let intermediate = "";
    try {
      await expect(extractSkillArchive({
        archive: makeStoredZip([
          { name: "SKILL.md", content: skillMarkdown() },
          { name: "assets/value.txt", content: "safe\n" }
        ]),
        stagingRoot: staging,
        hooks: {
          async beforeStageOperation(operation, absolute) {
            if (attacked || operation !== "write" || path.basename(absolute) !== "value.txt") return;
            attacked = true;
            intermediate = path.dirname(absolute);
            moved = `${intermediate}.moved`;
            await fs.rename(intermediate, moved);
            if (mode === "swap") {
              await fs.symlink(outside, intermediate);
            } else {
              await fs.mkdir(intermediate, { mode: 0o700 });
              await fs.rm(intermediate, { recursive: true });
              await fs.rename(moved, intermediate);
              moved = "";
            }
          }
        }
      })).rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
      expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
    } finally {
      if (intermediate && await exists(intermediate) && (await fs.lstat(intermediate)).isSymbolicLink()) {
        await fs.unlink(intermediate);
      }
      if (moved && await exists(moved)) await fs.rename(moved, intermediate);
    }
  });

  it("keeps the final staging write on the worker-bound inode after the visible parent becomes an outside symlink", async () => {
    const staging = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "unchanged\n");
    let attacked = false;
    let container = "";
    let moved = "";
    try {
      await expect(extractSkillArchive({
        archive: makeStoredZip([{ name: "SKILL.md", content: skillMarkdown() }]),
        stagingRoot: staging,
        hooks: {
          async beforeBoundStageOperation(operation, absolute) {
            if (attacked || operation !== "write") return;
            attacked = true;
            container = path.dirname(absolute);
            moved = `${container}.bound-moved`;
            await fs.rename(container, moved);
            await fs.symlink(outside, container);
          }
        }
      })).rejects.toMatchObject({ code: "SKILL_PACKAGE_CHANGED" });
      expect(await fs.readFile(path.join(moved, "SKILL.md"), "utf8")).toContain("name: test-skill");
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
      expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
    } finally {
      if (container && await exists(container) && (await fs.lstat(container)).isSymbolicLink()) await fs.unlink(container);
      if (moved && await exists(moved)) await fs.rename(moved, container);
    }
  });

  it.each(["symlink", "regular"])(
    "rejects an initial %s staging-root swap against the caller-pinned lineage with zero outside writes",
    async (mode) => {
      const staging = await fs.realpath(await temporaryDirectory());
      const outside = await fs.realpath(await temporaryDirectory());
      const sentinel = path.join(outside, "sentinel.txt");
      await fs.writeFile(sentinel, "unchanged\n");
      const identity = await pinDirectoryIdentity(staging, staging);
      const moved = `${staging}-initial-moved`;
      let attacked = false;
      try {
        await expect(extractSkillArchive({
          archive: makeStoredZip([{ name: "SKILL.md", content: skillMarkdown() }]),
          stagingRoot: staging,
          stagingRootIdentity: identity,
          hooks: {
            async beforeInitialRootBind() {
              if (attacked) return;
              attacked = true;
              await fs.rename(staging, moved);
              if (mode === "symlink") await fs.symlink(outside, staging);
              else await fs.rename(outside, staging);
            }
          }
        } as Parameters<typeof extractSkillArchive>[0])).rejects.toBeTruthy();
        const visibleOutside = mode === "symlink" ? outside : staging;
        expect(await fs.readFile(path.join(visibleOutside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
        expect((await fs.readdir(visibleOutside)).sort()).toEqual(["sentinel.txt"]);
      } finally {
        if (await exists(staging)) {
          if ((await fs.lstat(staging)).isSymbolicLink()) await fs.unlink(staging);
          else if (mode === "regular" && attacked) await fs.rename(staging, outside);
        }
        if (await exists(moved)) await fs.rename(moved, staging);
      }
    }
  );

  it.each(["symlink", "regular"])("rejects an initial %s inspect-root swap before reading outside", async (mode) => {
    const root = await fs.realpath(await temporaryDirectory());
    const outside = await fs.realpath(await temporaryDirectory());
    await fs.writeFile(path.join(root, "SKILL.md"), skillMarkdown());
    await fs.writeFile(path.join(outside, "SKILL.md"), skillMarkdown("outside-skill"));
    await fs.writeFile(path.join(outside, "secret.txt"), "outside-secret\n");
    const moved = `${root}-inspect-moved`;
    let attacked = false;
    try {
      await expect(inspectSkillDirectory(root, {}, {
        async beforeRootRealpath() {
          if (attacked) return;
          attacked = true;
          await fs.rename(root, moved);
          if (mode === "symlink") await fs.symlink(outside, root);
          else await fs.rename(outside, root);
        }
      } as never)).rejects.toBeTruthy();
      const visibleOutside = mode === "symlink" ? outside : root;
      expect(await fs.readFile(path.join(visibleOutside, "secret.txt"), "utf8")).toBe("outside-secret\n");
    } finally {
      if (await exists(root)) {
        if ((await fs.lstat(root)).isSymbolicLink()) await fs.unlink(root);
        else if (mode === "regular" && attacked) await fs.rename(root, outside);
      }
      if (await exists(moved)) await fs.rename(moved, root);
    }
  });

  it("sorts Skill paths without locale-sensitive comparison", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, "SKILL.md"), skillMarkdown());
    await fs.writeFile(path.join(directory, "ä.txt"), "a\n");
    await fs.writeFile(path.join(directory, "z.txt"), "z\n");
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare is forbidden for Skill path ordering");
    });
    try {
      await expect(inspectSkillDirectory(directory)).resolves.toBeTruthy();
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("bounds empty-directory entries and recursion depth", async () => {
    const many = await temporaryDirectory();
    await fs.writeFile(path.join(many, "SKILL.md"), skillMarkdown());
    await Promise.all(Array.from({ length: 512 }, (_, index) =>
      fs.mkdir(path.join(many, `empty-${String(index).padStart(3, "0")}`))
    ));
    await expect(inspectSkillDirectory(many)).rejects.toMatchObject({ code: "SKILL_ARCHIVE_ENTRY_LIMIT" });

    const deep = await temporaryDirectory();
    await fs.writeFile(path.join(deep, "SKILL.md"), skillMarkdown());
    let current = deep;
    for (let index = 0; index < 17; index += 1) {
      current = path.join(current, `d${index}`);
      await fs.mkdir(current);
    }
    await expect(inspectSkillDirectory(deep)).rejects.toMatchObject({ code: "SKILL_PACKAGE_DEPTH_LIMIT" });
  });
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-skill-archive-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(candidate: string) {
  try { await fs.lstat(candidate); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
