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
  it("accepts the real Native and Docker workbench roots for an administrator private turn", async () => {
    const workspace = await temporaryAgentWorkspace();
    const nativeRoot = await resolveAgentWorkbench(workspace, "native");
    const dockerRoot = await resolveAgentWorkbench(workspace, "docker");

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "native",
      path.join(nativeRoot, "fixtures", "native.png")
    )).resolves.toEqual({
      path: path.join("fixtures", "native.png"),
      backend: "native",
      exactBackend: true
    });
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "native",
      path.join(dockerRoot, "fixtures", "docker.png")
    )).resolves.toEqual({
      path: path.join("fixtures", "docker.png"),
      backend: "docker",
      exactBackend: true
    });
  });

  it("maps Docker-visible absolute paths to the matching authorized workbench", async () => {
    const workspace = await temporaryAgentWorkspace();

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "docker",
      "/workbench/fixtures/docker.png"
    )).resolves.toEqual({
      path: path.join("fixtures", "docker.png"),
      backend: "docker",
      exactBackend: true
    });
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "docker",
      "/workbench/native-workbench/selfie/reference.png"
    )).resolves.toEqual({
      path: path.join("selfie", "reference.png"),
      backend: "native",
      exactBackend: true
    });
  });

  it("keeps relative paths on the conversation backend and rejects absolute escapes", async () => {
    const workspace = await temporaryAgentWorkspace();
    const nativeRoot = await resolveAgentWorkbench(workspace, "native");

    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "docker",
      "fixtures/reference.png"
    )).resolves.toEqual({
      path: "fixtures/reference.png",
      backend: "docker",
      exactBackend: false
    });
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "docker",
      path.join(nativeRoot, "fixtures", "private.png")
    )).rejects.toThrow("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "native",
      "/workbench/../outside.png"
    )).rejects.toThrow("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
    await expect(resolveWorkbenchImageReferenceAddress(
      workspace,
      "native",
      "/etc/passwd"
    )).rejects.toThrow("WORKBENCH_IMAGE_PATH_OUTSIDE_AUTHORIZED_ROOT");
  });
});

async function temporaryAgentWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-workbench-image-path-"));
  roots.push(root);
  return path.join(root, "agent");
}
