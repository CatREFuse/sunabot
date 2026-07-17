// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

import { useConversationTools } from "./useConversationTools";

describe("useConversationTools", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("loads the Agent catalog and persists only the current conversation selection", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/tools") {
        return Promise.resolve({
          tools: [
            { name: "read_file", title: "读取文件", description: "读取文件", enabled: true },
            { name: "workspace_bash", title: "Bash", description: "运行命令", enabled: false }
          ]
        });
      }
      if (path === "/api/conversations/private%3A7/tools" && init?.method === "PUT") {
        return Promise.resolve({ conversationId: "private:7", disabledTools: ["read_file"] });
      }
      if (path === "/api/conversations/private%3A7/tools") {
        return Promise.resolve({ conversationId: "private:7", disabledTools: ["workspace_bash"] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationTools("private:7");

    await expect(state.load()).resolves.toBe(true);
    expect(state.tools.value.map((tool) => tool.name)).toEqual(["read_file", "workspace_bash"]);
    expect(state.disabledTools.value).toEqual(["workspace_bash"]);

    await expect(state.save(["read_file"])).resolves.toBe(true);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/conversations/private%3A7/tools",
      { method: "PUT", body: JSON.stringify({ disabledTools: ["read_file"] }) }
    );
    expect(state.disabledTools.value).toEqual(["read_file"]);
  });

  it("keeps the server state when saving fails", async () => {
    apiRequest.mockRejectedValue(new Error("保存失败"));
    const state = useConversationTools("web:admin");

    await expect(state.save(["codex"])).resolves.toBe(false);

    expect(state.disabledTools.value).toEqual([]);
    expect(state.error.value).toBe("保存失败");
  });

  it("does not accept a policy load when the Agent catalog is unavailable", async () => {
    apiRequest.mockImplementation((path: string) => path === "/api/tools"
      ? Promise.reject(new Error("目录不可用"))
      : Promise.resolve({ conversationId: "web:admin", disabledTools: ["codex"] }));
    const state = useConversationTools("web:admin");

    await expect(state.load()).resolves.toBe(false);

    expect(state.disabledTools.value).toEqual([]);
    expect(state.error.value).toBe("目录不可用");
  });
});
