// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { writeSelfieReferenceCatalog } from "../../services/media/selfieReferenceCatalog.js";
import { SunaRuntime } from "../../src/runtime.js";
import { MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES } from "../../src/runtime/runtimeContracts.js";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];
const runtimes: SunaRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime selfie references", () => {
  it("loads a deterministic compatibility subset of at most three workspace references", async () => {
    const { config } = await createRuntimeFixture("subset", 4, false);
    const runtime = createRuntime(config);

    const first = await runtime.loadSelfieReferenceImages();
    const second = await runtime.loadSelfieReferenceImages();

    expect(MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES).toBe(3);
    expect(first).toHaveLength(3);
    expect(first).toEqual(second);
    expect(first.every((value) => value.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("injects all selfie ids and notes without paths or image bytes", async () => {
    const { config, references } = await createRuntimeFixture("payload", 9);
    config.persona.defaultAgentId = "arona";
    config.persona.name = "阿罗娜";
    const runtime = createRuntime(config);
    const renderPromptRequest = vi.spyOn(runtime, "renderPromptRequest").mockResolvedValue({
      messages: [{ role: "user", content: "rewrite" }],
      tools: [],
      response_format: { type: "json_schema" }
    });
    const completeRequest = vi.fn(async () => JSON.stringify({
      prompt: "rewritten selfie prompt",
      selectedSelfieReferenceIds: [references[8]!.id, references[2]!.id]
    }));
    const provider = { completeRequest } as unknown as OpenAIProvider;
    const logContext = { conversationId: "group:7788", stage: "reply" } as const;

    await expect(runtime.rewriteSelfiePrompt(provider, "自拍", "1024x1024", {
      workspaceSelfies: references.map(({ id, note }) => ({ id, note })),
      chatReferenceImageCount: 1
    }, logContext)).resolves.toEqual({
      prompt: "rewritten selfie prompt",
      selectedSelfieReferenceIds: [references[8]!.id, references[2]!.id]
    });

    const variables = renderPromptRequest.mock.calls[0]![1];
    expect(variables["selfie.payload"]).toMatchObject({
      persona: { name: "阿罗娜" },
      references: {
        workspaceSelfies: references.map(({ id, note }) => ({ id, note })),
        workspaceSelectionLimit: 3,
        chatImageCount: 1
      }
    });
    const serializedPayload = JSON.stringify(variables["selfie.payload"]);
    expect(serializedPayload).not.toContain(config.persona.agentWorkspace);
    expect(serializedPayload).not.toContain("base64");
    expect(completeRequest).toHaveBeenCalledWith(expect.any(Object), {
      logContext: { ...logContext, promptFamily: "image.selfie-rewrite" }
    });
  });

  it("uses the generic selfie persona name when no loaded or configured name exists", async () => {
    const config = createAdminTestConfig(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-selfie-name-")));
    roots.push(path.dirname(config.persona.agentWorkspace));
    config.persona.defaultAgentId = "secondary";
    config.persona.name = " ";
    const runtime = createRuntime(config);
    const renderPromptRequest = vi.spyOn(runtime, "renderPromptRequest").mockResolvedValue({
      messages: [{ role: "user", content: "rewrite" }],
      tools: [],
      response_format: { type: "json_schema" }
    });
    const referenceId = "a".repeat(64);
    const provider = {
      completeRequest: vi.fn(async () => JSON.stringify({
        prompt: "rewritten selfie prompt",
        selectedSelfieReferenceIds: [referenceId]
      }))
    } as unknown as OpenAIProvider;

    await runtime.rewriteSelfiePrompt(provider, "自拍", "1024x1024", {
      workspaceSelfies: [{ id: referenceId, note: "默认造型" }],
      chatReferenceImageCount: 0
    });

    expect(renderPromptRequest.mock.calls[0]![1]["selfie.payload"])
      .toMatchObject({ persona: { name: "助手" } });
  });

  it.each([
    { selectedCount: 1, withChatReference: false },
    { selectedCount: 1, withChatReference: true },
    { selectedCount: 2, withChatReference: false },
    { selectedCount: 2, withChatReference: true },
    { selectedCount: 3, withChatReference: false },
    { selectedCount: 3, withChatReference: true }
  ])("keeps $selectedCount workspace references in node order with chat=$withChatReference", async ({
    selectedCount,
    withChatReference
  }) => {
    const { config, references } = await createRuntimeFixture("selection", 4);
    const runtime = createRuntime(config);
    const openFile = vi.spyOn(fs, "open");
    const selectedReferences = [references[2]!, references[0]!, references[3]!].slice(0, selectedCount);
    vi.spyOn(runtime, "rewriteSelfiePrompt").mockResolvedValue({
      prompt: "rewritten selfie prompt",
      selectedSelfieReferenceIds: selectedReferences.map(({ id }) => id)
    });
    const generateImage = vi.fn(async () => ({
      url: "/generated-images/agents/arona/selfie.png",
      filePath: "/tmp/selfie.png"
    }));
    const provider = { generateImage } as unknown as OpenAIProvider;

    const result = await runtime.runSelfie(withChatReference ? {
      ...selfieInput(),
      referenceMediaHandles: ["message:generated:image:0"]
    } : selfieInput(), provider, withChatReference ? {
      chatReferenceImageUrls: ["https://example.test/current.png"],
      imageReferences: {
        currentImageUrls: ["https://example.test/current.png"],
        mediaByHandle: {
          "message:generated:image:0": "/generated-images/agents/arona/previous.png"
        }
      }
    } : {});

    const expectedReferences = [
      ...selectedReferences.map(({ dataUrl }) => dataUrl),
      ...(withChatReference ? ["/generated-images/agents/arona/previous.png"] : [])
    ];

    expect(generateImage).toHaveBeenCalledWith(
      "rewritten selfie prompt",
      expect.any(String),
      "high",
      expectedReferences,
      undefined
    );
    expect(result).toMatchObject({
      ok: true,
      referenceImageCount: selectedCount + Number(withChatReference),
      workspaceReferenceImageCount: selectedCount,
      chatReferenceImageCount: Number(withChatReference)
    });
    expect(expectedReferences).toHaveLength(selectedCount + Number(withChatReference));
    if (withChatReference) {
      expect(expectedReferences.at(-1)).toBe("/generated-images/agents/arona/previous.png");
    }
    expect(openFile.mock.calls
      .map(([filePath]) => String(filePath))
      .filter((filePath) => filePath.endsWith(".png"))
      .map((filePath) => path.basename(filePath))
      .sort()).toEqual(selectedReferences.map(({ fileName }) => fileName).sort());
    openFile.mockRestore();
  });

  it("fails closed before image generation for invalid node selections", async () => {
    const { config, references } = await createRuntimeFixture("invalid-selection", 4);
    const runtime = createRuntime(config);
    vi.spyOn(runtime, "renderPromptRequest").mockResolvedValue({
      messages: [{ role: "user", content: "rewrite" }],
      tools: [],
      response_format: { type: "json_schema" }
    });
    const completeRequest = vi.fn<() => Promise<string>>();
    const generateImage = vi.fn();
    const provider = { completeRequest, generateImage } as unknown as OpenAIProvider;
    const validPrompt = "rewritten selfie prompt";
    const invalidResults = [
      "not-json",
      JSON.stringify({ prompt: validPrompt, selectedSelfieReferenceIds: [] }),
      JSON.stringify({ prompt: validPrompt, selectedSelfieReferenceIds: ["f".repeat(64)] }),
      JSON.stringify({ prompt: validPrompt, selectedSelfieReferenceIds: [references[0]!.id, references[0]!.id] }),
      JSON.stringify({ prompt: validPrompt, selectedSelfieReferenceIds: references.map(({ id }) => id) }),
      JSON.stringify({ prompt: validPrompt, selectedSelfieReferenceIds: [references[0]!.id], extra: true })
    ];

    for (const invalidResult of invalidResults) {
      completeRequest.mockResolvedValueOnce(invalidResult);
      await expect(runtime.runSelfie(selfieInput(), provider)).rejects.toThrow();
    }

    expect(generateImage).not.toHaveBeenCalled();
  });

  it("rejects a workspace catalog above nine images", async () => {
    const { config } = await createRuntimeFixture("limit", 10, false);
    const runtime = createRuntime(config);
    const completeRequest = vi.fn();
    const generateImage = vi.fn();
    const provider = { completeRequest, generateImage } as unknown as OpenAIProvider;

    await expect(runtime.runSelfie(selfieInput(), provider)).rejects.toThrow("最多保留 9 张");
    expect(completeRequest).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("rejects a symlinked selfie directory and oversized manual image before the node call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-selfie-path-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    const workspace = config.persona.agentWorkspace;
    const externalDirectory = path.join(root, "external-selfie");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(externalDirectory);
    await fs.symlink(externalDirectory, path.join(workspace, "selfie"));
    const runtime = createRuntime(config);
    const completeRequest = vi.fn();
    const generateImage = vi.fn();
    const provider = { completeRequest, generateImage } as unknown as OpenAIProvider;

    await expect(runtime.runSelfie(selfieInput(), provider)).rejects.toThrow("regular directory");

    await fs.rm(path.join(workspace, "selfie"));
    await fs.mkdir(path.join(workspace, "selfie"));
    await fs.writeFile(path.join(workspace, "selfie", "oversized.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(runtime.runSelfie(selfieInput(), provider)).rejects.toThrow("8 MiB");
    expect(completeRequest).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("rejects a selfie directory replacement after node selection", async () => {
    const { config, references } = await createRuntimeFixture("directory-replacement", 1);
    const runtime = createRuntime(config);
    const selfieDirectory = path.join(config.persona.agentWorkspace, "selfie");
    const movedDirectory = path.join(config.persona.agentWorkspace, "selfie-before-selection");
    const replacementDirectory = path.join(config.persona.agentWorkspace, "selfie-replacement");
    vi.spyOn(runtime, "rewriteSelfiePrompt").mockImplementation(async () => {
      await fs.rename(selfieDirectory, movedDirectory);
      await fs.mkdir(replacementDirectory);
      await fs.symlink(replacementDirectory, selfieDirectory);
      return {
        prompt: "rewritten selfie prompt",
        selectedSelfieReferenceIds: [references[0]!.id]
      };
    });
    const generateImage = vi.fn();
    const provider = { generateImage } as unknown as OpenAIProvider;

    await expect(runtime.runSelfie(selfieInput(), provider)).rejects.toThrow(
      "Selfie reference directory changed during selection."
    );
    expect(generateImage).not.toHaveBeenCalled();
  });
});

interface FixtureReference {
  id: string;
  fileName: string;
  note: string;
  dataUrl: string;
}

async function createRuntimeFixture(name: string, count: number, writeManifest = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sunabot-runtime-selfie-${name}-`));
  roots.push(root);
  const config = createAdminTestConfig(root);
  const selfieDirectory = path.join(config.persona.agentWorkspace, "selfie");
  await fs.mkdir(selfieDirectory, { recursive: true });
  const references: FixtureReference[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: index * 20, g: 80, b: 120 } }
    }).png().toBuffer();
    const id = crypto.createHash("sha256").update(bytes).digest("hex");
    const fileName = `look-${String(index).padStart(2, "0")}-${id}.png`;
    const note = `造型 ${index + 1}`;
    await fs.writeFile(path.join(selfieDirectory, fileName), bytes);
    references.push({
      id,
      fileName,
      note,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
    });
  }
  await fs.writeFile(path.join(selfieDirectory, "ignored.txt"), "not an image", "utf8");
  if (writeManifest && count <= 9) {
    await writeSelfieReferenceCatalog(selfieDirectory, references.map(({ id, fileName, note }) => ({ id, fileName, note })));
  }
  return { config, references };
}

function createRuntime(config: AppConfig) {
  const runtime = new SunaRuntime(config, { attachmentService: {} as never });
  runtimes.push(runtime);
  return runtime;
}

function selfieInput() {
  return {
    prompt: "自拍",
    size: null,
    resolution: "1K",
    quality: "high",
    referenceImageUrls: null,
    referenceMediaHandles: null,
    referenceImageSource: "none"
  };
}
