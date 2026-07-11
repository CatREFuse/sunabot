// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProviderSmokeWorkspace } from "../../tooling/quality/prepare-runtime-smoke.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("prepare provider smoke workspace", () => {
  it("copies only the selected provider credential into the new layout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      server: { host: "0.0.0.0", port: 8787 },
      persona: { defaultAgentId: "plana", agentWorkspace: "workspace/agents/plana" },
      providers: {
        defaultProviderId: "selected",
        items: [
          { id: "selected", kind: "openai-responses", model: "test-model", apiKeyEnv: "SELECTED_KEY", envFile: "workspace/.env", enabled: true },
          { id: "unused", kind: "openai-responses", model: "unused", apiKeyEnv: "UNUSED_KEY", enabled: true }
        ]
      },
      bot: { adminQq: "171419991" },
      onebot: { reverseWsPath: "/onebot/v11/ws", accessTokenEnv: "ONEBOT_ACCESS_TOKEN" }
    }));
    await write(path.join(source, ".env"), "SELECTED_KEY=selected-secret\nUNUSED_KEY=must-not-copy\nBARK_URL=must-not-copy\n");
    await write(path.join(source, "agents/plana/AGENTS.md"), "test agent\n");

    const result = await prepareProviderSmokeWorkspace({ source, destination, confirmCredentialCopy: true });
    const config = JSON.parse(await fs.readFile(result.configPath, "utf8"));
    const environment = await fs.readFile(result.envPath, "utf8");
    expect(config.server).toEqual({ host: "127.0.0.1", port: 18_876 });
    expect(config.persona.agentWorkspace).toBe("workspace/business/agents/plana");
    expect(config.providers.items).toHaveLength(1);
    expect(config.providers.items[0].envFile).toBe("workspace/secrets/runtime.env");
    expect(environment).toContain("SELECTED_KEY=");
    expect(environment).toContain("ONEBOT_ACCESS_TOKEN=");
    expect(environment).not.toContain("must-not-copy");
    await expect(fs.readFile(path.join(destination, "business/agents/plana/AGENTS.md"), "utf8"))
      .resolves.toBe("test agent\n");
  });

  it("refuses an external provider credential path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-external-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const external = path.join(root, "external.env");
    await write(external, "KEY=secret\n");
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      providers: { defaultProviderId: "selected", items: [{ id: "selected", apiKeyEnv: "KEY", envFile: external }] }
    }));

    await expect(prepareProviderSmokeWorkspace({ source, destination, confirmCredentialCopy: true }))
      .rejects.toThrow(/不在源 workspace/);
  });
});

async function write(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
