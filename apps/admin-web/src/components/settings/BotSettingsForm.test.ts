import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BotSettingsForm from "./BotSettingsForm.vue";

describe("BotSettingsForm", () => {
  it("shows the Agent reply debounce in seconds and saves it as milliseconds", async () => {
    const modelValue = {
      adminQq: "171419991",
      adminName: "猫老师",
      replyDebounceMs: 5_000,
      pokeOnNoReply: false,
      quoteGroupReplies: true,
      quoteGroupReplyExcludedUserIds: [],
      contextMessageLimit: 48,
      emojiSendSize: 512 as const
    };
    const reply = {
      reverseWsPath: "/onebot/v11/ws",
      accessTokenEnv: "ONEBOT_ACCESS_TOKEN",
      autoReplyPrivate: true,
      autoReplyUserGroup: true,
      autoReplyBotGroup: false,
      mentionNames: ["普拉娜"],
      commandPrefixes: ["/suna"]
    };
    const wrapper = mount(BotSettingsForm, {
      props: { modelValue, reply }
    });

    const input = wrapper.get<HTMLInputElement>('[data-config-field="bot.replyDebounceMs"]');
    expect(input.element.value).toBe("5");

    await input.setValue("7.5");
    await wrapper.get('[data-confirm-label="确认输入防抖时间"]').trigger("click");

    expect(modelValue.replyDebounceMs).toBe(7_500);
  });
});
