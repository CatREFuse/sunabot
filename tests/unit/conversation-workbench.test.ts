// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createConversationCapabilityContext,
  resolveConversationWorkbench
} from "../../services/conversations/conversationCapability.js";

describe("conversation capability Workbench routing", () => {
  it.each([
    {
      label: "administrator private chat",
      scope: "private" as const,
      isAdmin: true
    },
    {
      label: "ordinary private chat",
      scope: "private" as const,
      isAdmin: false
    },
    {
      label: "administrator group chat",
      scope: "user_group" as const,
      isAdmin: true
    },
    {
      label: "ordinary group chat",
      scope: "user_group" as const,
      isAdmin: false
    }
  ])("uses one route for chat export, Codex input and send_file in $label", ({
    scope,
    isAdmin
  }) => {
    const context = createConversationCapabilityContext({
      agentId: "arona",
      accountId: "secondary",
      conversationId: scope === "private"
        ? "account:secondary:private:1001"
        : "account:secondary:group:3003",
      transport: "onebot",
      scope,
      userId: 1001,
      isAdmin,
      messageId: 885282521,
      configEpoch: 7
    });

    expect(resolveConversationWorkbench(context, "chat_media_export").primaryBackend)
      .toBe("native");
    expect(resolveConversationWorkbench(context, "codex_input").primaryBackend)
      .toBe("native");
    expect(resolveConversationWorkbench(context, "send_file").primaryBackend)
      .toBe("native");
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("uses the exact canonical Workbench plan without a source fallback", () => {
    const context = createConversationCapabilityContext({
      agentId: "arona",
      accountId: "secondary",
      conversationId: "account:secondary:private:1001",
      transport: "onebot",
      scope: "private",
      userId: 1001,
      isAdmin: true,
      messageId: 885282521,
      configEpoch: 7
    });

    expect(resolveConversationWorkbench(context, "send_file")).toMatchObject({
      primaryBackend: "native",
      readableBackends: ["native"],
      writableBackends: ["native"],
      fallbackPolicy: "none"
    });
    expect(resolveConversationWorkbench(context, "chat_media_export")).toMatchObject({
      primaryBackend: "native",
      readableBackends: ["native"],
      writableBackends: ["native"],
      fallbackPolicy: "none"
    });
  });

  it("rejects forged or incomplete capability identity fields", () => {
    expect(() => createConversationCapabilityContext({
      agentId: "../other",
      accountId: "secondary",
      conversationId: "account:secondary:private:1001",
      transport: "onebot",
      scope: "private",
      userId: 1001,
      isAdmin: false,
      messageId: 1,
      configEpoch: 1
    })).toThrow("CONVERSATION_CAPABILITY_INVALID");

    expect(() => createConversationCapabilityContext({
      agentId: "arona",
      accountId: "",
      conversationId: "account:secondary:private:1001",
      transport: "onebot",
      scope: "private",
      userId: 1001,
      isAdmin: false,
      messageId: 1,
      configEpoch: 1
    })).toThrow("CONVERSATION_CAPABILITY_INVALID");
  });

  it("routes authenticated Web Codex artifacts to Native without exposing chat media", () => {
    const context = createConversationCapabilityContext({
      agentId: "arona",
      accountId: "web-admin",
      conversationId: "web:admin",
      transport: "web",
      scope: "private",
      userId: 1001,
      isAdmin: true,
      configEpoch: 7
    });

    expect(resolveConversationWorkbench(context, "codex_input").primaryBackend).toBe("native");
    expect(resolveConversationWorkbench(context, "codex_artifact").primaryBackend).toBe("native");
    expect(() => resolveConversationWorkbench(context, "chat_media_export"))
      .toThrow("CONVERSATION_CAPABILITY_INVALID");
  });
});
