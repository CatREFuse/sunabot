import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentWorkbench } from "../../services/agents/agentWorkbench.js";
import { resolveWorkbenchImageReferenceAddress } from "../../services/media/workbenchImageReference.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workbench image reference addresses", () => {
  it("resolves absolute paths from the canonical workbench root", async () => {
    const workspace = await temporaryAgentWorkspace();
    const workbenchRoot = await resolveAgentWorkbench(workspace);

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      path.join(workbenchRoot, "fixtures", "canonical.png")
    )).resolves.toEqual({
      path: path.join("fixtures", "canonical.png")
    });
  });

  it("maps /workbench paths to the canonical root and rejects the retired projection", async () => {
    const workspace = await temporaryAgentWorkspace();

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "/workbench/fixtures/reference.png"
    )).resolves.toEqual({
      path: path.join("fixtures", "reference.png")
    });
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "/workbench/native-workbench/selfie/reference.png"
    )).rejects.toThrow("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
  });

  it("keeps relative paths on the canonical workbench and rejects absolute escapes", async () => {
    const workspace = await temporaryAgentWorkspace();
    const workbenchRoot = await resolveAgentWorkbench(workspace);

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "fixtures/reference.png"
    )).resolves.toEqual({
      path: "fixtures/reference.png"
    });
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      path.join(workbenchRoot, "fixtures", "private.png")
    )).resolves.toEqual({
      path: path.join("fixtures", "private.png")
    });
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "/workbench/../outside.png"
    )).rejects.toThrow("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "/etc/passwd"
    )).rejects.toThrow("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
  });

  it("resolves portable knowledge image paths from the canonical workbench", async () => {
    const workspace = await temporaryAgentWorkspace();

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "knowledge/memory-images/reference.png"
    )).resolves.toEqual({
      path: path.join("knowledge", "memory-images", "reference.png")
    });
  });
});

async function temporaryAgentWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workbench-image-path-"));
  roots.push(root);
  return path.join(root, "agent");
}
