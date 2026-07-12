// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { SunaRuntime } from "../../src/runtime.js";
import { MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES } from "../../src/runtime/runtimeContracts.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];
const runtimes: SunaRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime selfie references", () => {
  it("loads at most three workspace reference images", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-selfie-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    const selfieDirectory = path.join(config.persona.agentWorkspace, "selfie");
    await fs.mkdir(selfieDirectory, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const bytes = await sharp({
        create: { width: 16, height: 16, channels: 3, background: { r: index * 40, g: 80, b: 120 } }
      }).png().toBuffer();
      await fs.writeFile(path.join(selfieDirectory, `${index}.png`), bytes);
    }
    await fs.writeFile(path.join(selfieDirectory, "ignored.txt"), "not an image", "utf8");

    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);
    const references = await runtime.loadSelfieReferenceImages();

    expect(MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES).toBe(3);
    expect(references).toHaveLength(3);
    expect(references.every((value) => value.startsWith("data:image/png;base64,"))).toBe(true);
  });
});
