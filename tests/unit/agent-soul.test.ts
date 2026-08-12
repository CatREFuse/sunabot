// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_FILE_DEFINITIONS } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { AgentFileRepository } from "../../src/admin/agentFiles.js";
import {
  AgentSoulService,
  MAX_AGENT_SOUL_BYTES,
  type AgentSoulServiceOptions
} from "../../src/admin/agentSoul.js";
import { AdminMutationMutex } from "../../src/admin/mutation.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
let config = createAdminTestConfig("/");
let repository: AgentFileRepository;
let service: AgentSoulService;
let reloadPrompts: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-soul-"));
  config = createAdminTestConfig(root);
  config.persona.defaultAgentId = "plana";
  config.persona.name = "普拉娜";
  await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
  for (const definition of personaDefinitions()) {
    const fileName = definition.fileName(config);
    await fs.mkdir(path.dirname(path.join(config.persona.agentWorkspace, fileName)), { recursive: true });
    await fs.writeFile(
      path.join(config.persona.agentWorkspace, fileName),
      definition.kind === "final" ? defaultPromptContent(definition.id) : `${definition.id}\n`,
      "utf8"
    );
  }
  reloadPrompts = vi.fn(async () => undefined);
  repository = new AgentFileRepository({ runtime: { reloadPrompts }, mutex: new AdminMutationMutex() });
  const registry = {
    get: vi.fn(async () => ({ id: "plana", name: "普拉娜" })),
    config: vi.fn(async () => structuredClone(config))
  } as unknown as AgentSoulServiceOptions["registry"];
  service = new AgentSoulService({ registry, repositoryFor: () => repository });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("AgentSoulService", () => {
  it("exports only every persona-scope prompt and round-trips through preview and apply", async () => {
    const exported = await service.export("plana");
    const document = JSON.parse(exported.bytes.toString("utf8"));

    expect(exported.fileName).toBe("plana.sunabot-soul.json");
    expect(document).toMatchObject({ schema: "sunabot.soul", version: 1, source: { agentId: "plana", name: "普拉娜" } });
    expect(document.files.map((file: { id: string }) => file.id)).toEqual(personaDefinitions().map((definition) => definition.id));
    expect(document.files.every((file: { content: string; sha256: string }) => sha256(file.content) === file.sha256)).toBe(true);
    const serialized = exported.bytes.toString("utf8");
    for (const forbidden of [config.bot.adminQq, "TAVILY_API_KEY", "agent.json", "workbench", "SQLite", "NapCat"]) {
      expect(serialized).not.toContain(forbidden);
    }

    const upload = { fileName: exported.fileName, dataBase64: exported.bytes.toString("base64") };
    const unchanged = await service.preview("plana", upload);
    expect(unchanged.files.every((file) => file.change === "unchanged")).toBe(true);

    await fs.writeFile(path.join(config.persona.agentWorkspace, "SOUL.md"), "changed target\n", "utf8");
    const preview = await service.preview("plana", upload);
    expect(preview.files.find((file) => file.id === "persona.soul")?.change).toBe("replace");
    await expect(service.apply("plana", {
      ...upload,
      packageSha256: preview.packageSha256,
      targetRevision: preview.targetRevision
    })).resolves.toMatchObject({ ok: true, imported: personaDefinitions().length });
    expect(await fs.readFile(path.join(config.persona.agentWorkspace, "SOUL.md"), "utf8")).toBe("persona.soul\n");
    expect(reloadPrompts).toHaveBeenCalledOnce();

    const reexported = JSON.parse((await service.export("plana")).bytes.toString("utf8"));
    expect(reexported.files).toEqual(document.files);
  });

  it("rejects strict schema, catalog, hash and prompt validation errors", async () => {
    const exported = await service.export("plana");
    const base = JSON.parse(exported.bytes.toString("utf8"));
    const cases: Array<[string, (document: any) => void, string]> = [
      ["future version", (document) => { document.version = 2; }, "AGENT_SOUL_VERSION_UNSUPPORTED"],
      ["extra root key", (document) => { document.secret = "value"; }, "AGENT_SOUL_SCHEMA_INVALID"],
      ["missing id", (document) => { document.files.pop(); }, "AGENT_SOUL_FILE_MISSING"],
      ["duplicate id", (document) => { document.files[1] = structuredClone(document.files[0]); }, "AGENT_SOUL_FILE_DUPLICATE"],
      ["unknown id", (document) => { document.files[0].id = "persona.unknown"; }, "AGENT_SOUL_FILE_UNKNOWN"],
      ["unsafe id", (document) => { document.files[0].id = "persona.\u001bunsafe"; }, "AGENT_SOUL_FILE_INVALID"],
      ["wrong file name", (document) => { document.files[0].fileName = "WRONG.md"; }, "AGENT_SOUL_FILE_NAME_MISMATCH"],
      ["wrong kind", (document) => { document.files[0].kind = "final"; }, "AGENT_SOUL_FILE_KIND_MISMATCH"],
      ["wrong digest", (document) => { document.files[0].sha256 = "0".repeat(64); }, "AGENT_SOUL_FILE_HASH_MISMATCH"],
      ["unknown variable", (document) => {
        document.files[0].content = "@{secret.value}\n";
        document.files[0].sha256 = sha256(document.files[0].content);
      }, "PROMPT_VARIABLE_UNKNOWN"],
      ["invalid final prompt", (document) => {
        const finalFile = document.files.find((file: { kind: string }) => file.kind === "final");
        finalFile.content = "{}\n";
        finalFile.sha256 = sha256(finalFile.content);
      }, "PROMPT_MESSAGES_INVALID"]
    ];

    for (const [label, mutate, code] of cases) {
      const document = structuredClone(base);
      mutate(document);
      await expect(service.preview("plana", upload(document)), label).rejects.toMatchObject({ code });
    }
    await expect(service.preview("plana", {
      fileName: "plana.sunabot-soul.json",
      dataBase64: Buffer.from([0xff, 0xfe]).toString("base64")
    })).rejects.toMatchObject({ code: "AGENT_SOUL_UTF8_INVALID" });
    await expect(service.preview("plana", {
      fileName: "plana.sunabot-soul.json",
      dataBase64: Buffer.alloc(MAX_AGENT_SOUL_BYTES + 1, 0x20).toString("base64")
    })).rejects.toMatchObject({ code: "AGENT_SOUL_TOO_LARGE", statusCode: 413 });
  });

  it("binds apply to the exact package bytes shown in preview", async () => {
    const exported = await service.export("plana");
    const payload = { fileName: exported.fileName, dataBase64: exported.bytes.toString("base64") };
    const preview = await service.preview("plana", payload);
    const changedBytes = Buffer.from(exported.bytes.toString("utf8").replace("普拉娜", "阿罗娜"), "utf8");

    await expect(service.apply("plana", {
      fileName: payload.fileName,
      dataBase64: changedBytes.toString("base64"),
      packageSha256: preview.packageSha256,
      targetRevision: preview.targetRevision
    })).rejects.toMatchObject({ code: "AGENT_SOUL_PACKAGE_CHANGED", statusCode: 409 });
    expect(reloadPrompts).not.toHaveBeenCalled();
  });

  it("rejects apply when the target revision changes after preview", async () => {
    const exported = await service.export("plana");
    const payload = { fileName: exported.fileName, dataBase64: exported.bytes.toString("base64") };
    const preview = await service.preview("plana", payload);
    await fs.writeFile(path.join(config.persona.agentWorkspace, "USER.md"), "concurrent edit\n", "utf8");

    await expect(service.apply("plana", {
      ...payload,
      packageSha256: preview.packageSha256,
      targetRevision: preview.targetRevision
    })).rejects.toMatchObject({ code: "AGENT_FILE_BATCH_REVISION_CONFLICT", statusCode: 409 });
    expect(await fs.readFile(path.join(config.persona.agentWorkspace, "USER.md"), "utf8")).toBe("concurrent edit\n");
    expect(reloadPrompts).not.toHaveBeenCalled();
  });
});

function personaDefinitions() {
  return PROMPT_FILE_DEFINITIONS.filter((definition) => definition.scope === "persona");
}

function upload(document: unknown) {
  return {
    fileName: "plana.sunabot-soul.json",
    dataBase64: Buffer.from(`${JSON.stringify(document)}\n`, "utf8").toString("base64")
  };
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
