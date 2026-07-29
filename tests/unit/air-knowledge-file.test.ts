// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeAirKnowledge,
  readAirKnowledge,
  replaceAirKnowledge
} from "../../services/air/knowledgeFile.js";
import { defaultConfig } from "../../src/config.js";

const roots: string[] = [];

afterEach(async () => {
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
});

function document(value: string) {
  return `# 场域知识\n\n## 使用边界\n${value}\n\n## 场域约定\n${value}\n`;
}
