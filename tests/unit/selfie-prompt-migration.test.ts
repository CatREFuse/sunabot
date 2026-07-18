// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT,
  DEFAULT_GENERIC_SELFIE_PROMPT_REWRITE_PROMPT,
  DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT,
  defaultGenericSelfiePromptContent,
  defaultPromptContent,
  defaultFinalPromptTemplate
} from "../../services/agent/promptDefaults.js";
import { migrateSelfieReferenceSelectionTemplate } from "../../services/agent/promptWorkspace.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];
const runtimes: SunaRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("selfie prompt reference-selection migration", () => {
  it("uses the generic selfie prompt for every secondary Agent fallback path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-secondary-selfie-prompt-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    config.persona.defaultAgentId = "arona";
    config.persona.name = "阿罗娜";
    config.persona.agentWorkspace = path.join(root, "agents", "arona");
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);

    expect(runtime.defaultPromptContent("image.selfie-rewrite"))
      .toBe(defaultGenericSelfiePromptContent());

    await runtime.ensureAgentPromptFiles(config);
    const promptPath = path.join(config.persona.agentWorkspace, "selfie_prompt_rewrite.json");
    await expect(fs.readFile(promptPath, "utf8")).resolves.toBe(defaultGenericSelfiePromptContent());

    await fs.writeFile(promptPath, " \n", "utf8");
    const rendered = await runtime.renderPromptRequest("image.selfie-rewrite", {
      "selfie.payload": "{}"
    });
    const content = rendered.messages.map((message) => message.content).join("\n");
    expect(content).toContain(DEFAULT_GENERIC_SELFIE_PROMPT_REWRITE_PROMPT);
    expect(content).not.toContain(DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT);
  });

  it("keeps the Plana-specific selfie prompt for every primary fallback path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-primary-selfie-prompt-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);

    expect(runtime.defaultPromptContent("image.selfie-rewrite"))
      .toBe(defaultPromptContent("image.selfie-rewrite"));

    await runtime.ensureAgentPromptFiles(config);
    const promptPath = path.join(config.persona.agentWorkspace, "selfie_prompt_rewrite.json");
    await expect(fs.readFile(promptPath, "utf8"))
      .resolves.toBe(defaultPromptContent("image.selfie-rewrite"));

    await fs.writeFile(promptPath, " \n", "utf8");
    const rendered = await runtime.renderPromptRequest("image.selfie-rewrite", {
      "selfie.payload": "{}"
    });
    const content = rendered.messages.map((message) => message.content).join("\n");
    expect(content).toContain(DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT);
  });

  it("repairs each half-migrated state while preserving custom messages", () => {
    const canonical = defaultFinalPromptTemplate("image.selfie-rewrite")!;
    const customSystem = { role: "system" as const, content: "管理员自定义人格规则，不要输出 JSON。" };
    const payload = { role: "user" as const, content: "@{selfie.payload}" };
    const canonicalContract = { role: "system" as const, content: DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT };
    const fixtures: FinalPromptTemplate[] = [
      {
        messages: [customSystem, payload],
        tools: [],
        response_format: structuredClone(canonical.response_format)
      },
      {
        messages: [customSystem, canonicalContract, payload],
        tools: [],
        response_format: { type: "text" }
      },
      {
        messages: [customSystem, canonicalContract, payload],
        tools: [],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "selfie_prompt_rewrite",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                prompt: { type: "string", minLength: 1, maxLength: 4_000 },
                selectedSelfieReferenceIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 3,
                  items: { type: "string", pattern: "^[a-f0-9]{64}$" }
                }
              },
              required: ["prompt", "selectedSelfieReferenceIds"]
            }
          }
        }
      }
    ];

    for (const fixture of fixtures) {
      const migrated = migrateSelfieReferenceSelectionTemplate(fixture, canonical);
      expect(migrated.messages[0]).toEqual(customSystem);
      expect(migrated.messages.at(-2)).toEqual(canonicalContract);
      expect(migrated.messages.at(-1)).toEqual(payload);
      expect(migrated.messages.filter((message) => (
        typeof message === "object" && message.content === DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT
      ))).toHaveLength(1);
      expect(migrated.response_format).toEqual(canonical.response_format);
    }
  });

  it("runs once through lifecycle and preserves later administrator overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-prompt-migration-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const promptPath = path.join(config.persona.agentWorkspace, "selfie_prompt_rewrite.json");
    const legacy: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "保留我的自定义角色外观；只输出纯文本。" },
        { role: "user", content: "@{selfie.payload}" }
      ],
      tools: [],
      response_format: { type: "text" }
    };
    await fs.writeFile(promptPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);

    await runtime.ensureAgentPromptFiles(config);
    const migrated = JSON.parse(await fs.readFile(promptPath, "utf8"));
    expect(migrated.messages[0]).toEqual(legacy.messages[0]);
    expect(migrated.messages.at(-2)).toEqual({
      role: "system",
      content: DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT
    });
    expect(migrated.response_format.type).toBe("json_schema");
    const markerPath = path.join(
      config.persona.agentWorkspace,
      ".selfie_prompt_rewrite.json.reference-selection-v1"
    );
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("reference-selection-v1\n");

    migrated.messages = [migrated.messages[0], migrated.messages.at(-1)];
    migrated.response_format = { type: "text" };
    await fs.writeFile(promptPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    await runtime.ensureAgentPromptFiles(config);

    expect(JSON.parse(await fs.readFile(promptPath, "utf8"))).toEqual(migrated);
  });
});
