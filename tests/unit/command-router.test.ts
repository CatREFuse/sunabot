// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CommandRouter } from "../../src/commands/router.js";

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

  it("rejects duplicate command names during registration", () => {
    expect(() => new CommandRouter([
      { id: "first", names: ["summary"], handler: async () => undefined },
      { id: "second", names: ["SUMMARY"], handler: async () => undefined }
    ])).toThrow(/duplicate command name/i);
  });
});
