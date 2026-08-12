// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applicationDataStore, closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";
import { normalizeConversationDisabledTools } from "../../services/tools/conversationToolPolicy.js";

const roots: string[] = [];
const runtimes: SunaRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  closeApplicationDataStores();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("conversation tool policy", () => {
  it("does not allow memory-decision tools to be disabled by conversation settings", () => {
    expect(normalizeConversationDisabledTools([
      "add_workmemory",
      "add_user_profile",
      "read_file"
    ])).toEqual(["read_file"]);
  });

  it("persists an independent policy for QQ and Web Chat conversations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-conversation-tools-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);

    expect(runtime.getConversationToolPolicy("private:171419991")).toEqual({
      conversationId: "private:171419991",
      disabledTools: []
    });
    expect(runtime.setConversationToolPolicy({
      id: "private:171419991",
      disabledTools: ["read_file", "workspace_bash"]
    })).toEqual({
      conversationId: "private:171419991",
      disabledTools: ["read_file", "native_bash"]
    });
    runtime.setConversationToolPolicy({ id: "web:admin", disabledTools: ["codex"] });

    expect(applicationDataStore(config).readConversations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "private:171419991", disabledTools: ["read_file", "native_bash"] }),
      expect.objectContaining({ id: "web:admin", disabledTools: ["codex"] })
    ]));

    runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    closeApplicationDataStores();
    const reloaded = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(reloaded);
    expect(reloaded.getConversationToolPolicy("private:171419991").disabledTools)
      .toEqual(["read_file", "native_bash"]);
    expect(reloaded.getConversationToolPolicy("web:admin").disabledTools).toEqual(["codex"]);
  });
});
