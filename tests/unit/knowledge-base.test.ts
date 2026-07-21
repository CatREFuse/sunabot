import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  KnowledgeBaseService,
  chunkKnowledgeDocument
} from "../../services/knowledge/public.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("knowledge document chunking", () => {
  it("chunks JSONL by non-empty line", () => {
    expect(chunkKnowledgeDocument('{"id":1}\n\n{"id":2}\n', "jsonl")).toEqual([
      { ordinal: 0, startLine: 1, endLine: 1, content: '{"id":1}' },
      { ordinal: 1, startLine: 3, endLine: 3, content: '{"id":2}' }
    ]);
  });

  it("chunks Markdown and text by natural paragraph", () => {
    expect(chunkKnowledgeDocument("# 标题\n正文一\n\n正文二\n续行", "markdown")).toEqual([
      { ordinal: 0, startLine: 1, endLine: 2, content: "# 标题\n正文一" },
      { ordinal: 1, startLine: 4, endLine: 5, content: "正文二\n续行" }
    ]);
  });
});

describe("KnowledgeBaseService", () => {
  it("recursively indexes nested Markdown, text and JSONL files", async () => {
    const service = await fixture({
      "产品/路线.md": "# 路线\n\n知识库支持递归扫描。\n\n下一阶段增加权限。",
      "产品/说明.txt": "第一段\n\n第二段",
      "事件/记录.jsonl": '{"event":"上线"}\n{"event":"回滚"}\n'
    });

    const snapshot = await service.list();

    expect(snapshot).toMatchObject({ fileCount: 3, chunkCount: 7, errorCount: 0 });
    expect(snapshot.documents.map((document) => document.path)).toEqual([
      "事件/记录.jsonl",
      "产品/说明.txt",
      "产品/路线.md"
    ]);
  });

  it("uses BM25 to recall Chinese and Latin terms with source lines", async () => {
    const service = await fixture({
      "space/mars.md": "火星基地采用核能供电。\n\nMars habitat uses recycled water.",
      "space/moon.md": "月球基地采用太阳能供电。",
      "ops.txt": "普通运行记录。"
    });

    const chinese = await service.search({ query: "火星基地供电", limit: 5 });
    const english = await service.search({ query: "Mars recycled water", limit: 5 });

    expect(chinese.ok).toBe(true);
    expect(chinese.matches[0]).toMatchObject({ path: "space/mars.md", startLine: 1, endLine: 1 });
    expect(chinese.matches[0]?.score).toBeGreaterThan(0);
    expect(english.matches[0]).toMatchObject({ path: "space/mars.md", startLine: 3, endLine: 3 });
  });

  it("uploads Markdown into a nested folder, rejects overwrite and deletes safely", async () => {
    const service = await fixture({});

    const created = await service.uploadMarkdown({
      path: "手册/接入/开始.md",
      content: "# 开始\n\n完成配置后启动服务。"
    });
    expect(created.document).toMatchObject({ path: "手册/接入/开始.md", chunkCount: 2, status: "indexed" });
    await expect(service.uploadMarkdown({
      path: "手册/接入/开始.md",
      content: "重复"
    })).rejects.toMatchObject<Partial<ServiceError>>({ code: "KNOWLEDGE_DOCUMENT_EXISTS", statusCode: 409 });

    const removed = await service.deleteDocument("手册/接入/开始.md");
    expect(removed.snapshot.fileCount).toBe(0);
    expect((await service.search({ query: "启动服务" })).matches).toEqual([]);
  });

  it("ignores unsupported files and symbolic links during recursive scans", async () => {
    const root = await createRoot();
    const sourceRoot = path.join(root, "knowledge");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "visible.md"), "可检索正文");
    await fs.writeFile(path.join(sourceRoot, "ignored.pdf"), "not a pdf");
    await fs.symlink(path.join(sourceRoot, "visible.md"), path.join(sourceRoot, "linked.md"));
    const service = new KnowledgeBaseService({ sourceRoot, indexPath: path.join(root, "cache", "knowledge.sqlite") });

    const snapshot = await service.list();

    expect(snapshot.documents.map((document) => document.path)).toEqual(["visible.md"]);
  });
});

async function fixture(files: Record<string, string>) {
  const root = await createRoot();
  const sourceRoot = path.join(root, "knowledge");
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(sourceRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
  return new KnowledgeBaseService({
    sourceRoot,
    indexPath: path.join(root, "cache", "knowledge.sqlite"),
    now: () => new Date("2026-07-20T10:00:00.000Z")
  });
}

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-knowledge-"));
  temporaryRoots.push(root);
  return root;
}
