import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentResourcesMigration,
  planAgentResourcesMigration,
  rollbackAgentResourcesMigration,
  verifyAgentResourcesMigration
} from "../../tooling/migrations/migrate-agent-resources.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Agent resource layout migration", () => {
  it("moves authoritative resources into workbench, verifies them, and rolls back from backup", async () => {
    const workspace = await fixture();
    const plan = await planAgentResourcesMigration({ workspace });
    expect(plan.changesRequired).toBe(true);
    expect(plan.agents).toEqual([expect.objectContaining({
      agentId: "plana",
      changesRequired: true,
      emojiFiles: 2
    })]);

    const applied = await applyAgentResourcesMigration({
      workspace,
      quiesced: true,
      now: new Date("2026-07-25T00:00:00.000Z"),
      assertStopped: async () => undefined
    });
    expect(applied.ok).toBe(true);
    expect(applied.backup).toBe("backups/agent-workbenches-v2-2026-07-25T00-00-00-000Z");

    const agent = path.join(workspace, "business/agents/plana");
    const workbench = path.join(agent, "workbench");
    await expect(fs.readFile(path.join(workbench, "selfie/references.jsonl"), "utf8"))
      .resolves.toContain("\"schemaVersion\":1");
    await expect(fs.readFile(path.join(workbench, "skills/index.json"), "utf8"))
      .resolves.toContain("\"skills\": []");
    await expect(fs.readFile(path.join(workbench, "knowledge/index.json"), "utf8"))
      .resolves.toContain("\"root\": \"knowledge\"");
    await expect(fs.readFile(path.join(workbench, "emoji/emojis.jsonl"), "utf8"))
      .resolves.toContain("\"key\":\"wave\"");
    await expect(fs.readFile(path.join(agent, "workbench/index.md"), "utf8"))
      .resolves.toContain("`emoji/`");
    await expect(fs.readFile(path.join(agent, "docker-workbench/index.md"), "utf8"))
      .resolves.toContain("`native-workbench/emoji/`");
    await expect(fs.lstat(path.join(agent, "selfie"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyAgentResourcesMigration({ workspace })).resolves.toMatchObject({ ok: true });

    const emojiCatalogPath = path.join(workbench, "emoji/emojis.jsonl");
    const emojiCatalog = await fs.readFile(emojiCatalogPath);
    await fs.appendFile(emojiCatalogPath, "\n");
    await expect(verifyAgentResourcesMigration({ workspace })).resolves.toMatchObject({ ok: true });
    await fs.writeFile(emojiCatalogPath, emojiCatalog);

    await rollbackAgentResourcesMigration({
      workspace,
      backup: applied.backup,
      quiesced: true,
      assertStopped: async () => undefined
    });
    await expect(fs.readFile(path.join(agent, "selfie/references.jsonl"), "utf8"))
      .resolves.toContain("\"schemaVersion\":1");
    await expect(fs.readFile(path.join(workspace, "business/media/images/emojis.jsonl"), "utf8"))
      .resolves.toContain("\"key\":\"wave\"");
  });

  it("fails verification when a JSON management entry is damaged", async () => {
    const workspace = await fixture();
    await applyAgentResourcesMigration({
      workspace,
      quiesced: true,
      now: new Date("2026-07-25T00:00:00.000Z"),
      assertStopped: async () => undefined
    });
    await fs.writeFile(
      path.join(workspace, "business/agents/plana/workbench/skills/index.json"),
      "{broken"
    );

    await expect(verifyAgentResourcesMigration({ workspace })).rejects.toMatchObject({
      code: "AGENT_RESOURCES_INDEX_INVALID"
    });
  });
});

async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-resources-"));
  temporaryRoots.push(workspace);
  const agent = path.join(workspace, "business/agents/plana");
  const emojiRoot = path.join(workspace, "business/media/images");
  const emptyRevision = createHash("sha256").update("[]").digest("hex");
  await Promise.all([
    fs.mkdir(path.join(agent, "selfie"), { recursive: true }),
    fs.mkdir(path.join(agent, "extensions/skills"), { recursive: true }),
    fs.mkdir(path.join(agent, "extensions/mcp"), { recursive: true }),
    fs.mkdir(path.join(agent, "knowledge"), { recursive: true }),
    fs.mkdir(path.join(agent, "workbench"), { recursive: true }),
    fs.mkdir(emojiRoot, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(agent, "agent.json"), "{}\n"),
    fs.writeFile(path.join(agent, "workbench/index.md"), [
      "# 文件工作区",
      "",
      "本目录用于保存当前 Agent 的计划、下载、转存文件和任务产物。",
      "",
      "读取可访问的配置或资源目录时，先读取该目录的管理文件：当前目录使用 `index.md`，Skills 使用 `index.json`，MCP 使用 `servers.json`，自拍参考图使用 `references.jsonl`，表情使用 `emojis.jsonl`，知识库使用 `index.json`。",
      "",
      "管理文件缺失或损坏时停止猜测目录内容，并报告具体目录。",
      ""
    ].join("\n")),
    fs.writeFile(path.join(agent, "selfie/reference.png"), "selfie"),
    fs.writeFile(path.join(agent, "selfie/references.jsonl"), [
      JSON.stringify({
        schemaVersion: 1,
        id: createHash("sha256").update("selfie").digest("hex"),
        fileName: "reference.png",
        note: "reference"
      }),
      ""
    ].join("\n")),
    fs.writeFile(path.join(agent, "extensions/skills/index.json"), `${JSON.stringify({
      schemaVersion: 1,
      revision: emptyRevision,
      skills: []
    }, null, 2)}\n`),
    fs.writeFile(path.join(agent, "extensions/mcp/servers.json"), `${JSON.stringify({
      schemaVersion: 1,
      revision: emptyRevision,
      servers: []
    }, null, 2)}\n`),
    fs.writeFile(path.join(agent, "knowledge/note.md"), "# note\n"),
    fs.writeFile(path.join(emojiRoot, "emoji-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"), "emoji"),
    fs.writeFile(path.join(emojiRoot, "emojis.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      key: "wave",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      currentFileName: "emoji-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
      versions: [{
        fileName: "emoji-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        source: "upload",
        sizeBytes: 5,
        width: 1024,
        height: 1024,
        createdAt: "2026-07-25T00:00:00.000Z"
      }]
    })}\n`)
  ]);
  return workspace;
}
