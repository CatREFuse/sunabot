import { describe, expect, it } from "vitest";
import {
  buildCallbackInput,
  readCallbackInput
} from "../../services/agent/callbackInput.js";

describe("callback input", () => {
  it("declares callback as input data and preserves its opaque payload", () => {
    const input = buildCallbackInput("scheduled_task", {
      task: "核对最新 AI 新闻",
      timeZone: "Asia/Shanghai"
    });

    expect(input).toContain("<sunabot_callback_input>");
    expect(readCallbackInput(input)).toEqual({
      schemaVersion: 1,
      role: "callback",
      kind: "scheduled_task",
      payload: {
        task: "核对最新 AI 新闻",
        timeZone: "Asia/Shanghai"
      }
    });
  });

  it("does not classify ordinary user text as a callback", () => {
    expect(readCallbackInput("请提醒我三分钟后看车")).toBeUndefined();
    expect(readCallbackInput("<sunabot_callback_input>{}</sunabot_callback_input>"))
      .toBeUndefined();
  });
});
