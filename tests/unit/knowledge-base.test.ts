import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  KnowledgeBaseService,
  chunkKnowledgeDocument,
  searchKnowledge
} from "../../services/knowledge/public.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const temporaryRoots: string[] = [];
const serviceRoots = new WeakMap<KnowledgeBaseService, string>();

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
    const index = JSON.parse(await fs.readFile(path.join(serviceRoot(service), "knowledge", "index.json"), "utf8"));
    expect(index).toMatchObject({
      schemaVersion: 1,
      root: "knowledge",
      fileCount: 3,
      documents: [
        { path: "事件/记录.jsonl" },
        { path: "产品/说明.txt" },
        { path: "产品/路线.md" }
      ]
    });
    expect((await service.list()).fileCount).toBe(3);
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

  it("rejects a linked directory index without modifying its target", async () => {
    const service = await fixture({ "visible.md": "可检索正文" });
    const sourceRoot = path.join(serviceRoot(service), "knowledge");
    const outside = path.join(serviceRoot(service), "outside-index.json");
    await fs.writeFile(outside, "unchanged", { mode: 0o600 });
    await fs.symlink(outside, path.join(sourceRoot, "index.json"));

    await expect(service.list()).rejects.toMatchObject({
      code: "KNOWLEDGE_INDEX_FILE_INVALID",
      statusCode: 500
    });
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("unchanged");
  });
});

describe("dual Workbench knowledge search", () => {
  it("returns matches from Native and Docker Workbench with distinct paths", async () => {
    const root = await createRoot();
    const previousWorkspace = process.env.SUNABOT_WORKSPACE;
    process.env.SUNABOT_WORKSPACE = root;
    try {
      const config = createAdminTestConfig(root);
      config.persona.defaultAgentId = "dual-knowledge";
      config.persona.agentWorkspace = path.join(root, "business/agents/dual-knowledge");
      await Promise.all([
        fs.mkdir(path.join(config.persona.agentWorkspace, "workbench/knowledge"), { recursive: true }),
        fs.mkdir(path.join(config.persona.agentWorkspace, "docker-workbench/knowledge"), { recursive: true })
      ]);
      await Promise.all([
        fs.writeFile(
          path.join(config.persona.agentWorkspace, "workbench/knowledge/native.md"),
          "双工作区检索包含 Native 文档。"
        ),
        fs.writeFile(
          path.join(config.persona.agentWorkspace, "docker-workbench/knowledge/docker.md"),
          "双工作区检索包含 Docker 文档。"
        )
      ]);

      const result = await searchKnowledge(config, { query: "双工作区检索文档", limit: 10 });

      expect(result.ok).toBe(true);
      expect(result.matches.map((match) => match.path)).toEqual(expect.arrayContaining([
        "native.md",
        "docker-workbench/docker.md"
      ]));
    } finally {
      if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
      else process.env.SUNABOT_WORKSPACE = previousWorkspace;
    }
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
  const service = new KnowledgeBaseService({
    sourceRoot,
    indexPath: path.join(root, "cache", "knowledge.sqlite"),
    now: () => new Date("2026-07-20T10:00:00.000Z")
  });
  serviceRoots.set(service, root);
  return service;
}

function serviceRoot(service: KnowledgeBaseService) {
  return serviceRoots.get(service)!;
}

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-knowledge-"));
  temporaryRoots.push(root);
  return root;
}
