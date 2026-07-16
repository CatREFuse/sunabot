// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CommandRouter,
  commandInvocationSnapshot
} from "../../services/messaging/commandRouter.js";
import {
  MAX_COMMAND_INVOCATION_ARGS_CHARACTERS,
  MAX_COMMAND_INVOCATION_RAW_TEXT_CHARACTERS
} from "../../packages/contracts/messaging/commands.js";

describe("CommandRouter", () => {
  it.each([
    ["/总结群聊", "", "总结群聊"],
    ["／总结群聊 最近三小时", "最近三小时", "总结群聊"],
    ["/SUMMARY today", "today", "SUMMARY"],
    ["/summary@普拉娜 today", "today", "summary"]
  ])("matches registered command forms: %s", (text, args, invokedName) => {
    const handler = vi.fn(async () => undefined);
    const router = new CommandRouter([
      { id: "group-summary", names: ["总结群聊", "summary"], handler }
    ]);

    const match = router.match(text, ["普拉娜"]);

    expect(match).toEqual(expect.objectContaining({
      id: "group-summary",
      args,
      invokedName
    }));
  });

  it.each([
    "ping",
    "普拉娜 ping",
    "/unknown",
    "/summary-extra",
    "/summary@其他机器人"
  ])("leaves noncommands and unknown commands for the main model: %s", (text) => {
    const router = new CommandRouter([
      { id: "group-summary", names: ["summary"], handler: async () => undefined }
    ]);

    expect(router.match(text, ["普拉娜"])).toBeUndefined();
  });

  it("dispatches through the registered handler with parsed arguments", async () => {
    const handler = vi.fn(async () => "done");
    const router = new CommandRouter<{ channel: string }, string>([
      { id: "group-summary", names: ["总结群聊"], handler }
    ]);
    const match = router.match("/总结群聊 最近三小时");
    expect(match).toBeDefined();

    const result = await router.dispatch(match!, { channel: "group:1" });

    expect(result).toBe("done");
    expect(handler).toHaveBeenCalledWith(
      { channel: "group:1" },
      expect.objectContaining({ id: "group-summary", args: "最近三小时" })
    );
  });

  it("restores a frozen invocation by stable id without parsing current aliases", async () => {
    const handler = vi.fn(async () => "done");
    const router = new CommandRouter<{ channel: string }, string>([
      { id: "group-summary", names: ["新的名字"], handler }
    ]);
    const invocation = {
      id: "group-summary",
      invokedName: "旧的名字",
      args: "最近三小时",
      rawText: "/旧的名字@旧机器人 最近三小时"
    };

    const match = router.restore(invocation);
    const result = await router.dispatch(match, { channel: "group:1" });

    expect(result).toBe("done");
    expect(match).toEqual(expect.objectContaining(invocation));
    expect(handler).toHaveBeenCalledWith({ channel: "group:1" }, invocation);
  });

  it("freezes only bounded command data and never the handler definition", () => {
    const router = new CommandRouter([
      { id: "group-summary", names: ["summary"], handler: async () => undefined }
    ]);
    const match = router.match("/summary now");
    expect(match).toBeDefined();

    const snapshot = commandInvocationSnapshot(match!);

    expect(snapshot).toEqual({
      id: "group-summary",
      invokedName: "summary",
      args: "now",
      rawText: "/summary now"
    });
    expect(snapshot).not.toHaveProperty("definition");
  });

  it("fails closed when a frozen command id is no longer registered", () => {
    const router = new CommandRouter([
      { id: "group-summary", names: ["summary"], handler: async () => undefined }
    ]);

    expect(() => router.restore({
      id: "removed-command",
      invokedName: "summary",
      args: "",
      rawText: "/summary"
    })).toThrow(/unknown command id/i);
  });

  it("fails closed after a registered command exceeds durable limits", () => {
    const router = new CommandRouter([
      { id: "group-summary", names: ["summary"], handler: async () => undefined }
    ]);

    expect(() => router.match(`/summary ${"a".repeat(MAX_COMMAND_INVOCATION_ARGS_CHARACTERS + 1)}`))
      .toThrow(/exceeds durable limits/i);
    expect(() => router.match(`${" ".repeat(MAX_COMMAND_INVOCATION_RAW_TEXT_CHARACTERS)}/summary`))
      .toThrow(/exceeds durable limits/i);
  });

  it("rejects malformed frozen invocation data before restoring a handler", () => {
    const router = new CommandRouter([
      { id: "group-summary", names: ["summary"], handler: async () => undefined }
    ]);

    expect(() => router.restore({
      id: "group-summary",
      invokedName: "summary",
      args: "\0",
      rawText: "/summary"
    })).toThrow(/invalid command invocation/i);
  });

  it("rejects duplicate command names during registration", () => {
    expect(() => new CommandRouter([
      { id: "first", names: ["summary"], handler: async () => undefined },
      { id: "second", names: ["SUMMARY"], handler: async () => undefined }
    ])).toThrow(/duplicate command name/i);
  });

  it("rejects duplicate stable command ids during registration", () => {
    expect(() => new CommandRouter([
      { id: "group-summary", names: ["summary"], handler: async () => undefined },
      { id: "group-summary", names: ["总结群聊"], handler: async () => undefined }
    ])).toThrow(/duplicate command id/i);
  });
});
