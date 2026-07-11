import { describe, expect, it } from "vitest";
import { listToolMetadata, providerToolExecutionMode, resolveProviderToolDefinitions } from "../../services/tools/toolRegistry.js";

describe("ToolRegistry", () => {
  it("uses one canonical name for metadata and the model definition", () => {
    const metadata = listToolMetadata();
    const definitions = resolveProviderToolDefinitions({
      bash: { enabled: true, workspaceOnly: true, blockedKeywords: [] }
    });
    const names = definitions.map((definition) => String(definition.name));

    expect(metadata.some((tool) => tool.name === "workspace_bash")).toBe(true);
    expect(metadata.some((tool) => tool.name === "bash.run")).toBe(false);
    expect(names).toEqual(["workspace_bash"]);
    expect(providerToolExecutionMode("workspace_bash")).toBe("inline");
  });

  it("does not expose disabled provider tools", () => {
    expect(resolveProviderToolDefinitions({})).toEqual([]);
  });
});
