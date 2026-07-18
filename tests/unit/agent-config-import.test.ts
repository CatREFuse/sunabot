// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeAgentConfigImport,
  prepareAgentConfigImport
} from "../../services/agents/agentConfigImport.js";

const rules = {
  finalPromptFiles: ["selfie_prompt_rewrite.json"],
  systemPromptFiles: ["memory_compress.json"]
};
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Agent configuration import package", () => {
  it("accepts a wrapped folder, reports missing components, and never accepts unlisted files", async () => {
    const plan = await prepareAgentConfigImport({
      source: "folder",
      files: [
        file("arona/agent.json", JSON.stringify({ schemaVersion: 1, bot: {}, onebot: {} })),
        file("arona/AGENTS.md", "你是阿罗娜。"),
        file("arona/SOUL.md", "温柔。")
      ]
    }, rules);

    expect(plan.included).toEqual(["AGENTS.md", "SOUL.md", "agent.json"]);
    expect(plan.missing).not.toContain("Agent 配置");
    expect(plan.missing).toContain("人格文件：USER.md");

    await expect(prepareAgentConfigImport({
      source: "folder",
      files: [file("workspace/business/data/sunabot.sqlite", "not allowed")]
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_UNKNOWN_FILE" });
  });

  it("rejects duplicate, traversal, Unicode-confusable, and unknown folder paths before materializing", async () => {
    await expect(prepareAgentConfigImport({
      source: "folder",
      files: [file("AGENTS.md", "a"), file("AGENTS.md", "b")]
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_DUPLICATE_FILE" });

    await expect(prepareAgentConfigImport({
      source: "folder",
      files: [file("../AGENTS.md", "a")]
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_PATH_INVALID" });

    await expect(prepareAgentConfigImport({
      source: "folder",
      files: [file("A\u0308GENTS.md", "a")]
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_PATH_INVALID" });
  });

  it("rejects ZIP slip, non-regular ZIP entries, and configuration secrets", async () => {
    const slip = await zip({ "../agent.json": "{}" });
    await expect(prepareAgentConfigImport({
      source: "zip",
      fileName: "agent.zip",
      dataBase64: slip.toString("base64")
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_ARCHIVE_INVALID" });

    const symlink = await zip({ "AGENTS.md": "safe" });
    setFirstExternalAttributes(symlink, 0o120000 << 16);
    await expect(prepareAgentConfigImport({
      source: "zip",
      fileName: "agent.zip",
      dataBase64: symlink.toString("base64")
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_ARCHIVE_LINK" });

    const directorySymlink = await zip({ "linked/": "" });
    setFirstExternalAttributes(directorySymlink, 0o120000 << 16);
    await expect(prepareAgentConfigImport({
      source: "zip",
      fileName: "agent.zip",
      dataBase64: directorySymlink.toString("base64")
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_ARCHIVE_LINK" });

    const secret = await zip({ ".env": "OPENAI_API_KEY=secret" });
    await expect(prepareAgentConfigImport({
      source: "zip",
      fileName: "agent.zip",
      dataBase64: secret.toString("base64")
    }, rules)).rejects.toMatchObject({ code: "AGENT_IMPORT_UNKNOWN_FILE" });
  });

  it("normalizes imported selfie references by content hash when the optional manifest is absent", async () => {
    const plan = await prepareAgentConfigImport({
      source: "folder",
      files: [
        file("AGENTS.md", "你是测试角色。"),
        { path: "selfie/sample.png", dataBase64: png.toString("base64") }
      ]
    }, rules);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-import-"));
    temporaryDirectories.push(directory);

    await materializeAgentConfigImport(directory, plan);

    const manifest = JSON.parse(await fs.readFile(path.join(directory, "selfie", "references.json"), "utf8"));
    expect(manifest.references).toHaveLength(1);
    expect(manifest.references[0].fileName).toBe("sample.png");
    expect(manifest.references[0].id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an invalid selfie manifest even when the package contains no selfie images", async () => {
    const plan = await prepareAgentConfigImport({
      source: "folder",
      files: [file("selfie/references.json", JSON.stringify({ schemaVersion: 1, references: "invalid" }))]
    }, rules);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-import-"));
    temporaryDirectories.push(directory);

    await expect(materializeAgentConfigImport(directory, plan)).rejects.toMatchObject({
      statusCode: 400,
      code: "AGENT_IMPORT_SELFIE_MANIFEST_INVALID"
    });
  });
});

function file(path: string, content: string) {
  return { path, dataBase64: Buffer.from(content).toString("base64") };
}

async function zip(entries: Record<string, string>) {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(entries)) archive.file(name, content);
  return Buffer.from(await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function setFirstExternalAttributes(bytes: Buffer, attributes: number) {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const offset = bytes.indexOf(signature);
  if (offset < 0) throw new Error("ZIP central directory missing");
  bytes.writeUInt32LE(attributes >>> 0, offset + 38);
}
