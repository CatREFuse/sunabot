// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAirKnowledge,
  readAirKnowledge,
  replaceAirKnowledge
} from "../../services/air/knowledgeFile.js";
import { defaultConfig } from "../../src/config.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("AIR.md repository", () => {
  it("atomically replaces the expected revision and rejects a stale writer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-air-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.agentWorkspace = root;
    const initial = document("旧内容");
    await fs.writeFile(path.join(root, "AIR.md"), initial, "utf8");
    const before = await readAirKnowledge(config);

    const updated = await replaceAirKnowledge(config, before.revision, document("新内容"));
    expect(updated.status).toBe("updated");
    expect((await readAirKnowledge(config)).content).toContain("新内容");

    await expect(replaceAirKnowledge(config, before.revision, document("过时覆盖")))
      .resolves.toMatchObject({ status: "conflict" });
    expect((await readAirKnowledge(config)).content).not.toContain("过时覆盖");
  });

  it("rejects malformed replacement content", () => {
    expect(() => normalizeAirKnowledge("普通文本")).toThrow("# 场域知识");
    expect(() => normalizeAirKnowledge("# 场域知识\n\n## 使用边界\n内容")).toThrow("场域约定");
    expect(() => normalizeAirKnowledge(
      "# 场域知识\n\n## 使用边界\n内容\n\n## 公共百科\n内容\n\n## 场域约定\n内容"
    )).toThrow("unsupported or misplaced heading");
    expect(() => normalizeAirKnowledge(
      "# 场域知识\n\n## 场域约定\n内容\n\n## 使用边界\n内容"
    )).toThrow("unsupported or misplaced heading");
  });

  it("restores AIR.md when cancellation lands after atomic rename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-air-abort-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.agentWorkspace = root;
    const initial = document("关闭前内容");
    await fs.writeFile(path.join(root, "AIR.md"), initial, "utf8");
    const before = await readAirKnowledge(config);
    const controller = new AbortController();
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (oldPath, newPath) => {
      await originalRename(oldPath, newPath);
      controller.abort(new DOMException("Runtime closed.", "AbortError"));
    });

    await expect(replaceAirKnowledge(
      config,
      before.revision,
      document("关闭后的迟到内容"),
      controller.signal
    )).rejects.toMatchObject({ name: "AbortError" });

    const restored = await readAirKnowledge(config);
    expect(restored.revision).toBe(before.revision);
    expect(restored.content).toBe(before.content);
    expect(await fs.readdir(root)).toEqual(["AIR.md"]);
  });
});

function document(value: string) {
  return `# 场域知识\n\n## 使用边界\n${value}\n\n## 场域约定\n${value}\n`;
}
