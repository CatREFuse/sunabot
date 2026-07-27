import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkbench } from "../../services/agents/agentWorkbench.js";
import { RuntimeConversationAssets } from "../../src/runtime/conversationAssets.js";
import type { ParsedIncomingMessage } from "../../src/types.js";

const archiveConversationImage = vi.hoisted(() => vi.fn(async (
  agentId: string,
  prepared: { sha256?: string }
) => `/generated-images/conversation-assets/agents/${agentId}/${prepared.sha256}.png`));

vi.mock("../../services/media/conversationImageArchive.js", () => ({
  archiveConversationImage
}));

const roots: string[] = [];

afterEach(async () => {
  archiveConversationImage.mockClear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Runtime workbench image references", () => {
  it.each([
    {
      backend: "native" as const,
      requestedPath: (root: string) => path.join(root, "fixtures", "reference.png")
    },
    {
      backend: "docker" as const,
      requestedPath: () => "/workbench/fixtures/reference.png"
    }
  ])("reads an authorized $backend absolute path", async ({ backend, requestedPath }) => {
    const workspace = await temporaryAgentWorkspace();
    const workbench = await resolveAgentWorkbench(workspace, backend);
    await fs.mkdir(path.join(workbench, "fixtures"), { recursive: true });
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    await fs.writeFile(path.join(workbench, "fixtures", "reference.png"), imageBytes);
    const assets = new RuntimeConversationAssets({
      config: {
        persona: {
          agentWorkspace: workspace,
          defaultAgentId: "plana"
        }
      },
      isAdminUser: () => true
    } as never);

    await expect(assets.resolveImageReferences(
      adminPrivateIncoming(),
      [requestedPath(workbench)]
    )).resolves.toEqual([
      expect.stringMatching(/^\/generated-images\/conversation-assets\/agents\/plana\/[a-f0-9]{64}\.png$/)
    ]);
    expect(archiveConversationImage).toHaveBeenCalledWith(
      "plana",
      expect.objectContaining({
        kind: "image",
        byteLength: imageBytes.byteLength,
        source: `base64://${imageBytes.toString("base64")}`
      })
    );
  });
});

async function temporaryAgentWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workbench-image-"));
  roots.push(root);
  return path.join(root, "agent");
}

function adminPrivateIncoming() {
  return {
    scope: "private",
    userId: 10_001,
    groupId: undefined
  } as ParsedIncomingMessage;
}
