// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAgentWorkbench } from "../../services/agents/public.js";
import {
  readWorkbenchTextFile,
  writeWorkbenchTextFile
} from "../../services/tools/workbenchFileStore.js";
import {
  WORKBENCH_FILE_MAX_BYTES,
  WORKBENCH_FILE_MAX_CONTENT_LENGTH,
  isWorkbenchFileRelativePath
} from "../../services/tools/workbenchFileTool.js";

const TEST_DATA_ROOT = "/Users/tanshow/Developer/sunabot-dev-workspaces/workbench-file-tools";
const roots: string[] = [];

beforeAll(async () => {
  await fs.mkdir(TEST_DATA_ROOT, { recursive: true });
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("read_file and write_file storage", () => {
  it("rejects invalid arguments and POSIX path escapes before creating a workbench", async () => {
    const parent = await fixtureDirectory("invalid-");
    const agentWorkspace = path.join(parent, "missing-agent");
    for (const input of [
      null,
      {},
      { path: "" },
      { path: " reports/a.txt" },
      { path: "reports/a.txt " },
      { path: "." },
      { path: ".." },
      { path: "reports//a.txt" },
      { path: "reports/./a.txt" },
      { path: "reports/../a.txt" },
      { path: "../outside.txt" },
      { path: "/etc/passwd" },
      { path: "C:\\Windows\\system.ini" },
      { path: "reports\\a.txt" },
      { path: "reports/a.txt\u0000" },
      { path: "reports/ta\tb.txt" },
      { path: "reports/es\u001bcaped.txt" },
      { path: "reports/c1\u0085text.txt" },
      { path: "reports/raw-\ud800.txt" },
      { path: "reports/cafe\u0301.txt" },
      { path: "a".repeat(1_025) },
      { path: "a.txt", extra: true }
    ]) {
      await expect(readWorkbenchTextFile(agentWorkspace, input)).resolves.toMatchObject({
        ok: false,
        code: expect.stringMatching(/^WORKBENCH_FILE_(?:PATH|ARGUMENTS)_INVALID$/u)
      });
    }
    await expect(fs.lstat(agentWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads an existing stable UTF-8 file through one bounded descriptor", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    await fs.mkdir(path.join(workbench, "reports"));
    await fs.writeFile(path.join(workbench, "reports", "status.txt"), "状态：正常\n", { mode: 0o600 });

    await expect(readWorkbenchTextFile(agentWorkspace, { path: "reports/status.txt" })).resolves.toEqual({
      ok: true,
      path: "reports/status.txt",
      byteLength: Buffer.byteLength("状态：正常\n"),
      content: "状态：正常\n"
    });
  });

  it("preserves an existing UTF-8 BOM as text while counting its three bytes", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const content = "\ufeffBOM text\n";
    await fs.writeFile(path.join(workbench, "bom.txt"), Buffer.from(content, "utf8"), { mode: 0o600 });

    await expect(readWorkbenchTextFile(agentWorkspace, { path: "bom.txt" })).resolves.toEqual({
      ok: true,
      path: "bom.txt",
      byteLength: Buffer.byteLength(content, "utf8"),
      content
    });
  });

  it("round-trips a written UTF-8 BOM byte-for-byte without changing non-BOM text", async () => {
    const { agentWorkspace } = await agentFixture();
    const bomContent = "\ufeffwritten BOM";
    const plainContent = "plain text";

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "written-bom.txt",
      content: bomContent,
      overwrite: false
    })).resolves.toMatchObject({ ok: true, byteLength: Buffer.byteLength(bomContent, "utf8") });
    await expect(readWorkbenchTextFile(agentWorkspace, { path: "written-bom.txt" })).resolves.toEqual({
      ok: true,
      path: "written-bom.txt",
      byteLength: Buffer.byteLength(bomContent, "utf8"),
      content: bomContent
    });

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "plain.txt",
      content: plainContent,
      overwrite: false
    })).resolves.toMatchObject({ ok: true, byteLength: Buffer.byteLength(plainContent, "utf8") });
    await expect(readWorkbenchTextFile(agentWorkspace, { path: "plain.txt" })).resolves.toMatchObject({
      ok: true,
      byteLength: Buffer.byteLength(plainContent, "utf8"),
      content: plainContent
    });
  });

  it("requires NFC well-formed paths without folding case or aliasing U+FFFD", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const replacementPath = "raw-\ufffd.txt";
    const loneSurrogatePath = "raw-\ud800.txt";
    const nfcPath = "caf\u00e9.txt";
    const nfdPath = nfcPath.normalize("NFD");

    expect(isWorkbenchFileRelativePath(replacementPath)).toBe(true);
    expect(isWorkbenchFileRelativePath(loneSurrogatePath)).toBe(false);
    expect(isWorkbenchFileRelativePath(nfcPath)).toBe(true);
    expect(isWorkbenchFileRelativePath(nfdPath)).toBe(false);
    expect(isWorkbenchFileRelativePath("Case.txt")).toBe(true);
    expect(isWorkbenchFileRelativePath("case.txt")).toBe(true);

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: replacementPath,
      content: "replacement-code-point",
      overwrite: false
    })).resolves.toMatchObject({ ok: true });
    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: loneSurrogatePath,
      content: "must-not-alias",
      overwrite: true
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_PATH_INVALID" });
    await expect(readWorkbenchTextFile(agentWorkspace, { path: replacementPath }))
      .resolves.toMatchObject({ ok: true, content: "replacement-code-point" });

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: nfcPath,
      content: "nfc-file",
      overwrite: false
    })).resolves.toMatchObject({ ok: true });
    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: nfdPath,
      content: "must-not-alias",
      overwrite: true
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_PATH_INVALID" });
    await expect(readWorkbenchTextFile(agentWorkspace, { path: nfcPath }))
      .resolves.toMatchObject({ ok: true, content: "nfc-file" });
    expect(await fs.readFile(path.join(workbench, replacementPath), "utf8")).toBe("replacement-code-point");
    expect(await fs.readFile(path.join(workbench, nfcPath), "utf8")).toBe("nfc-file");
  });

  it("accepts the model-output boundary and rejects the next character", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const allowed = "a".repeat(WORKBENCH_FILE_MAX_CONTENT_LENGTH);
    await fs.writeFile(path.join(workbench, "allowed.txt"), allowed, { mode: 0o600 });
    await fs.writeFile(path.join(workbench, "too-many-characters.txt"), `${allowed}a`, { mode: 0o600 });

    const result = await readWorkbenchTextFile(agentWorkspace, { path: "allowed.txt" });
    expect(result).toMatchObject({ ok: true, byteLength: allowed.length });
    expect(result.ok && result.content.length).toBe(WORKBENCH_FILE_MAX_CONTENT_LENGTH);
    await expect(readWorkbenchTextFile(agentWorkspace, { path: "too-many-characters.txt" })).resolves.toMatchObject({
      ok: false,
      code: "WORKBENCH_FILE_TEXT_INVALID"
    });
  });

  it("rejects growth beyond the disk budget with an extra-byte probe", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    await fs.writeFile(
      path.join(workbench, "too-large.txt"),
      Buffer.alloc(WORKBENCH_FILE_MAX_BYTES + 1, 0x61),
      { mode: 0o600 }
    );

    await expect(readWorkbenchTextFile(agentWorkspace, { path: "too-large.txt" })).resolves.toMatchObject({
      ok: false,
      code: "WORKBENCH_FILE_TOO_LARGE"
    });
  });

  it("rejects a file that grows beyond the disk budget after descriptor validation", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const target = path.join(workbench, "growing.txt");
    await fs.writeFile(target, "a", { mode: 0o600 });

    await expect(readWorkbenchTextFile(agentWorkspace, { path: "growing.txt" }, {
      afterDescriptorOpened: async () => {
        await fs.appendFile(target, Buffer.alloc(WORKBENCH_FILE_MAX_BYTES, 0x61));
      }
    })).resolves.toMatchObject({
      ok: false,
      code: "WORKBENCH_FILE_TOO_LARGE"
    });
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["NUL text", Buffer.from("a\u0000b")],
    ["binary controls", Buffer.from([0x61, 0x07, 0x62])]
  ])("rejects %s", async (_label, bytes) => {
    const { agentWorkspace, workbench } = await agentFixture();
    await fs.writeFile(path.join(workbench, "binary.txt"), bytes, { mode: 0o600 });

    await expect(readWorkbenchTextFile(agentWorkspace, { path: "binary.txt" })).resolves.toMatchObject({
      ok: false,
      code: "WORKBENCH_FILE_TEXT_INVALID"
    });
  });

  it("rejects directories, leaf and intermediate symlinks, and hard links", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const outside = await fixtureDirectory("outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", { mode: 0o600 });
    await fs.mkdir(path.join(workbench, "directory"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(workbench, "leaf.txt"));
    await fs.symlink(outside, path.join(workbench, "linked-dir"));
    await fs.writeFile(path.join(workbench, "linked.txt"), "linked", { mode: 0o600 });
    await fs.link(path.join(workbench, "linked.txt"), path.join(workbench, "linked-copy.txt"));

    for (const relativePath of ["directory", "leaf.txt", "linked-dir/secret.txt", "linked.txt"]) {
      await expect(readWorkbenchTextFile(agentWorkspace, { path: relativePath })).resolves.toMatchObject({
        ok: false,
        code: "WORKBENCH_FILE_UNSAFE"
      });
    }
  });

  it("fails closed when the leaf changes after descriptor open", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const target = path.join(workbench, "target.txt");
    const moved = path.join(workbench, "moved.txt");
    await fs.writeFile(target, "trusted", { mode: 0o600 });

    const result = await readWorkbenchTextFile(agentWorkspace, { path: "target.txt" }, {
      afterDescriptorOpened: async () => {
        await fs.rename(target, moved);
        await fs.writeFile(target, "replacement", { mode: 0o600 });
      }
    });

    expect(result).toMatchObject({ ok: false, code: "WORKBENCH_FILE_CONFLICT" });
    expect(JSON.stringify(result)).not.toContain("trusted");
    expect(JSON.stringify(result)).not.toContain("replacement");
  });

  it("detects a leaf, intermediate directory, or root moved out and restored", async () => {
    for (const kind of ["leaf", "intermediate", "root"] as const) {
      const { agentWorkspace, workbench } = await agentFixture();
      const directory = path.join(workbench, "reports");
      const target = path.join(directory, "status.txt");
      await fs.mkdir(directory);
      await fs.writeFile(target, "trusted", { mode: 0o600 });
      const result = await readWorkbenchTextFile(agentWorkspace, { path: "reports/status.txt" }, {
        afterContentRead: async () => {
          const moved = `${kind === "root" ? workbench : kind === "intermediate" ? directory : target}.moved`;
          const candidate = kind === "root" ? workbench : kind === "intermediate" ? directory : target;
          await fs.rename(candidate, moved);
          await fs.rename(moved, candidate);
        }
      });
      expect(result, kind).toMatchObject({ ok: false, code: expect.stringMatching(/CONFLICT|UNSAFE/u) });
    }
  });

  it("creates a 0600 file atomically without making parent directories", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    await fs.mkdir(path.join(workbench, "reports"), { mode: 0o700 });

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "reports/status.txt",
      content: "ready\n",
      overwrite: false
    })).resolves.toEqual({
      ok: true,
      path: "reports/status.txt",
      byteLength: 6,
      created: true,
      overwritten: false
    });
    expect(await fs.readFile(path.join(workbench, "reports", "status.txt"), "utf8")).toBe("ready\n");
    expect((await fs.lstat(path.join(workbench, "reports", "status.txt"))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.join(workbench, "reports"))).filter((name) => name.includes("sunabot-write"))).toEqual([]);

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "missing/status.txt",
      content: "no",
      overwrite: false
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_NOT_FOUND" });
    await expect(fs.lstat(path.join(workbench, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing target unchanged when overwrite is false", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const target = path.join(workbench, "status.txt");
    await fs.writeFile(target, "old", { mode: 0o600 });

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "status.txt",
      content: "new",
      overwrite: false
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_EXISTS" });
    expect(await fs.readFile(target, "utf8")).toBe("old");
  });

  it("atomically replaces one stable regular file when overwrite is true", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const target = path.join(workbench, "status.txt");
    await fs.writeFile(target, "old", { mode: 0o600 });
    const previous = await fs.lstat(target);

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "status.txt",
      content: "complete-new-content",
      overwrite: true
    })).resolves.toMatchObject({ ok: true, created: false, overwritten: true });
    expect(await fs.readFile(target, "utf8")).toBe("complete-new-content");
    expect((await fs.lstat(target)).ino).not.toBe(previous.ino);
  });

  it("serializes same-path writes and never publishes partial content", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const first = "A".repeat(32_768);
    const second = "B".repeat(32_768);
    const [firstResult, secondResult] = await Promise.all([
      writeWorkbenchTextFile(agentWorkspace, { path: "race.txt", content: first, overwrite: true }),
      writeWorkbenchTextFile(agentWorkspace, { path: "race.txt", content: second, overwrite: true })
    ]);

    expect(firstResult).toMatchObject({ ok: true, created: true });
    expect(secondResult).toMatchObject({ ok: true, overwritten: true });
    expect(await fs.readFile(path.join(workbench, "race.txt"), "utf8")).toBe(second);
    expect((await fs.readdir(workbench)).filter((name) => name.includes("sunabot-write"))).toEqual([]);
  });

  it("lets exactly one concurrent no-overwrite create succeed", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const results = await Promise.all([
      writeWorkbenchTextFile(agentWorkspace, { path: "race.txt", content: "first", overwrite: false }),
      writeWorkbenchTextFile(agentWorkspace, { path: "race.txt", content: "second", overwrite: false })
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "WORKBENCH_FILE_EXISTS" })
    ]);
    expect(await fs.readFile(path.join(workbench, "race.txt"), "utf8")).toBe("first");
  });

  it("cleans its temporary file when publication is interrupted", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const result = await writeWorkbenchTextFile(agentWorkspace, {
      path: "interrupted.txt",
      content: "complete",
      overwrite: false
    }, {
      beforePublish: () => {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      }
    });

    expect(result).toMatchObject({ ok: false, code: "WORKBENCH_FILE_UNAVAILABLE" });
    expect(await fs.readdir(workbench)).toEqual([]);
  });

  it("does not replace a target that appears or changes immediately before publication", async () => {
    for (const existed of [false, true]) {
      const { agentWorkspace, workbench } = await agentFixture();
      const target = path.join(workbench, existed ? "existing.txt" : "new.txt");
      if (existed) await fs.writeFile(target, "original", { mode: 0o600 });

      const result = await writeWorkbenchTextFile(agentWorkspace, {
        path: path.basename(target),
        content: "tool-content",
        overwrite: existed
      }, {
        beforePublish: async () => {
          if (existed) await fs.unlink(target);
          await fs.writeFile(target, "racer-content", { mode: 0o600 });
        }
      });

      expect(result, existed ? "changed target" : "appeared target").toMatchObject({
        ok: false,
        code: expect.stringMatching(/WORKBENCH_FILE_(?:CONFLICT|UNSAFE)/u)
      });
      expect(await fs.readFile(target, "utf8")).toBe("racer-content");
      expect((await fs.readdir(workbench)).filter((name) => name.includes("sunabot-write"))).toEqual([]);
    }
  });

  it("rejects temp content, size, identity, and link tampering before publishing new or existing targets", async () => {
    for (const hookName of ["afterTempSynced", "beforePublish"] as const) {
      for (const existed of [false, true]) {
        for (const tamper of ["same-size", "grow", "shrink", "replace", "hardlink"] as const) {
          const { agentWorkspace, workbench } = await agentFixture();
          const target = path.join(workbench, existed ? "existing.txt" : "new.txt");
          const attackerLink = path.join(workbench, "attacker-hardlink.txt");
          if (existed) await fs.writeFile(target, "ORIGINAL", { mode: 0o600 });
          const hook = async () => tamperTemporaryFile(workbench, attackerLink, tamper);

          const result = await writeWorkbenchTextFile(agentWorkspace, {
            path: path.basename(target),
            content: "GOOD",
            overwrite: existed
          }, hookName === "afterTempSynced" ? { afterTempSynced: hook } : { beforePublish: hook });

          expect(result, `${hookName}/${existed ? "existing" : "new"}/${tamper}`).toMatchObject({
            ok: false,
            code: expect.stringMatching(/WORKBENCH_FILE_(?:CONFLICT|UNSAFE|UNAVAILABLE)/u)
          });
          if (existed) {
            expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
          } else {
            await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect((await fs.readdir(workbench)).filter((name) => name.includes("sunabot-write"))).toEqual([]);
          await fs.unlink(attackerLink).catch(() => undefined);
        }
      }
    }
  });

  it("revalidates published content through a no-follow descriptor", async () => {
    for (const existed of [false, true]) {
      const { agentWorkspace, workbench } = await agentFixture();
      const target = path.join(workbench, existed ? "existing.txt" : "new.txt");
      if (existed) await fs.writeFile(target, "ORIGINAL", { mode: 0o600 });

      const result = await writeWorkbenchTextFile(agentWorkspace, {
        path: path.basename(target),
        content: "GOOD",
        overwrite: existed
      }, {
        afterPublish: async () => {
          const handle = await fs.open(target, "r+");
          try {
            await handle.write(Buffer.from("EVIL"), 0, 4, 0);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      });

      expect(result, existed ? "existing" : "new").toMatchObject({
        ok: false,
        code: expect.stringMatching(/WORKBENCH_FILE_(?:CONFLICT|UNSAFE)/u)
      });
      expect(await fs.readFile(target, "utf8")).toBe("EVIL");
      expect((await fs.readdir(workbench)).filter((name) => name.includes("sunabot-write"))).toEqual([]);
    }
  });

  it("rejects write symlinks, hard links, unsafe parents, and root swap-back", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const outside = await fixtureDirectory("outside-");
    await fs.writeFile(path.join(outside, "outside.txt"), "outside", { mode: 0o600 });
    await fs.symlink(path.join(outside, "outside.txt"), path.join(workbench, "leaf.txt"));
    await fs.writeFile(path.join(workbench, "hard.txt"), "hard", { mode: 0o600 });
    await fs.link(path.join(workbench, "hard.txt"), path.join(workbench, "hard-copy.txt"));
    await fs.mkdir(path.join(workbench, "wide"), { mode: 0o777 });
    await fs.chmod(path.join(workbench, "wide"), 0o777);

    for (const [label, operation] of [
      ["symlink", () => writeWorkbenchTextFile(agentWorkspace, { path: "leaf.txt", content: "x", overwrite: true })],
      ["hard link", () => writeWorkbenchTextFile(agentWorkspace, { path: "hard.txt", content: "x", overwrite: true })],
      ["wide parent", () => writeWorkbenchTextFile(agentWorkspace, { path: "wide/x.txt", content: "x", overwrite: false })]
    ] as const) {
      const result = await operation();
      expect(result, label).toMatchObject({ ok: false, code: "WORKBENCH_FILE_UNSAFE" });
    }

    const swapResult = await writeWorkbenchTextFile(agentWorkspace, {
      path: "swap.txt",
      content: "x",
      overwrite: false
    }, {
      afterPrepared: async () => {
        const moved = `${workbench}.moved`;
        await fs.rename(workbench, moved);
        await fs.rename(moved, workbench);
      }
    });
    expect(swapResult).toMatchObject({ ok: false, code: expect.stringMatching(/CONFLICT|UNSAFE/u) });
    await expect(fs.lstat(path.join(workbench, "swap.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(outside, "outside.txt"), "utf8")).toBe("outside");
  });

  it("rejects invalid write text and budgets before filesystem access", async () => {
    const parent = await fixtureDirectory("invalid-write-");
    const agentWorkspace = path.join(parent, "missing-agent");
    for (const input of [
      { path: "x.txt", content: "x", overwrite: "yes" },
      { path: "x.txt", content: "a\u0000b", overwrite: false },
      { path: "ta\tb.txt", content: "x", overwrite: false },
      { path: "es\u001bcaped.txt", content: "x", overwrite: false },
      { path: "c1\u0085text.txt", content: "x", overwrite: false },
      { path: "raw-\ud800.txt", content: "x", overwrite: false },
      { path: "cafe\u0301.txt", content: "x", overwrite: false },
      { path: "x.txt", content: "raw-\ud800-text", overwrite: false },
      { path: "x.txt", content: "a".repeat(WORKBENCH_FILE_MAX_CONTENT_LENGTH + 1), overwrite: false },
      { path: "x.txt", content: "x", overwrite: false, extra: true }
    ]) {
      await expect(writeWorkbenchTextFile(agentWorkspace, input)).resolves.toMatchObject({ ok: false });
    }
    await expect(fs.lstat(agentWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the exact write text boundary and rejects directory targets", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const content = "a".repeat(WORKBENCH_FILE_MAX_CONTENT_LENGTH);
    await fs.mkdir(path.join(workbench, "directory"));

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "boundary.txt",
      content,
      overwrite: false
    })).resolves.toMatchObject({ ok: true, byteLength: content.length });
    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "directory",
      content: "x",
      overwrite: true
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_UNSAFE" });
  });

  it("rejects lone-surrogate content without publishing and preserves valid text byte-for-byte", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    const original = path.join(workbench, "original.txt");
    const decomposedContent = "cafe\u0301";
    await fs.writeFile(original, "original", { mode: 0o600 });

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "new.txt",
      content: "invalid-\ud800-text",
      overwrite: false
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_TEXT_INVALID" });
    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "original.txt",
      content: "invalid-\ud800-text",
      overwrite: true
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_TEXT_INVALID" });
    await expect(fs.lstat(path.join(workbench, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(original, "utf8")).toBe("original");

    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "decomposed-content.txt",
      content: decomposedContent,
      overwrite: false
    })).resolves.toMatchObject({ ok: true });
    await expect(readWorkbenchTextFile(agentWorkspace, { path: "decomposed-content.txt" }))
      .resolves.toMatchObject({ ok: true, content: decomposedContent });
    expect(decomposedContent).not.toBe(decomposedContent.normalize("NFC"));
  });

  it("redacts host paths and fs metadata from all failures", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    await fs.writeFile(path.join(workbench, "source.txt"), "text", { mode: 0o600 });
    const hostPath = "/Users/tanshow/private/secret.txt";
    const error = Object.assign(new Error(`EIO read ${hostPath}`), {
      code: "EIO",
      path: hostPath,
      dest: "/private/destination",
      syscall: "read",
      errno: -5
    });
    const readResult = await readWorkbenchTextFile(agentWorkspace, { path: "source.txt" }, {
      afterPrepared: () => { throw error; }
    });
    const writeResult = await writeWorkbenchTextFile(agentWorkspace, {
      path: "new.txt",
      content: "text",
      overwrite: false
    }, {
      afterPrepared: () => { throw error; }
    });

    for (const result of [readResult, writeResult]) {
      const serialized = JSON.stringify(result);
      expect(result).toMatchObject({ ok: false, code: "WORKBENCH_FILE_UNAVAILABLE" });
      expect(serialized).not.toContain(hostPath);
      expect(serialized).not.toContain("destination");
      expect(serialized).not.toContain("syscall");
      expect(serialized).not.toContain("errno");
    }
  });

  it("maps permission failures to one stable public error", async () => {
    const { agentWorkspace, workbench } = await agentFixture();
    await fs.writeFile(path.join(workbench, "source.txt"), "text", { mode: 0o600 });
    const forbidden = Object.assign(new Error("permission denied"), { code: "EACCES" });

    await expect(readWorkbenchTextFile(agentWorkspace, { path: "source.txt" }, {
      afterPrepared: () => { throw forbidden; }
    })).resolves.toEqual({
      ok: false,
      code: "WORKBENCH_FILE_FORBIDDEN",
      error: "The workbench file cannot be accessed."
    });
    await expect(writeWorkbenchTextFile(agentWorkspace, {
      path: "target.txt",
      content: "text",
      overwrite: false
    }, {
      afterPrepared: () => { throw forbidden; }
    })).resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_FORBIDDEN" });
  });

  it("keeps identical relative paths isolated by Agent workspace", async () => {
    const agentA = await agentFixture();
    const agentB = await agentFixture();
    await writeWorkbenchTextFile(agentA.agentWorkspace, { path: "shared.txt", content: "agent-a", overwrite: false });
    await writeWorkbenchTextFile(agentB.agentWorkspace, { path: "shared.txt", content: "agent-b", overwrite: false });

    await expect(readWorkbenchTextFile(agentA.agentWorkspace, { path: "shared.txt" }))
      .resolves.toMatchObject({ ok: true, content: "agent-a" });
    await expect(readWorkbenchTextFile(agentB.agentWorkspace, { path: "shared.txt" }))
      .resolves.toMatchObject({ ok: true, content: "agent-b" });
    await fs.unlink(path.join(agentA.workbench, "shared.txt"));
    await fs.symlink(path.join(agentB.workbench, "shared.txt"), path.join(agentA.workbench, "shared.txt"));
    await expect(readWorkbenchTextFile(agentA.agentWorkspace, { path: "shared.txt" }))
      .resolves.toMatchObject({ ok: false, code: "WORKBENCH_FILE_UNSAFE" });
  });
});

async function agentFixture() {
  const agentWorkspace = await fixtureDirectory("agent-");
  const workbench = await resolveAgentWorkbench(agentWorkspace);
  return { agentWorkspace, workbench };
}

async function fixtureDirectory(prefix: string) {
  const root = await fs.mkdtemp(path.join(TEST_DATA_ROOT, prefix));
  roots.push(root);
  return root;
}

async function tamperTemporaryFile(
  workbench: string,
  attackerLink: string,
  tamper: "same-size" | "grow" | "shrink" | "replace" | "hardlink"
) {
  const temporaryNames = (await fs.readdir(workbench)).filter((name) => name.includes("sunabot-write"));
  expect(temporaryNames).toHaveLength(1);
  const tempPath = path.join(workbench, temporaryNames[0]!);
  if (tamper === "same-size") {
    const handle = await fs.open(tempPath, "r+");
    try {
      await handle.write(Buffer.from("EVIL"), 0, 4, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (tamper === "grow") {
    await fs.appendFile(tempPath, "!");
    return;
  }
  if (tamper === "shrink") {
    await fs.truncate(tempPath, 2);
    return;
  }
  if (tamper === "replace") {
    await fs.unlink(tempPath);
    await fs.writeFile(tempPath, "EVIL", { flag: "wx", mode: 0o600 });
    return;
  }
  await fs.link(tempPath, attackerLink);
}
