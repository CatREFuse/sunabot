import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { ScheduledTask } from "../../types/scheduledTasks";
import ScheduledTaskEditorDialog from "./ScheduledTaskEditorDialog.vue";

describe("ScheduledTaskEditorDialog", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("submits a raw cron task with multiple callback targets", async () => {
    const wrapper = mount(ScheduledTaskEditorDialog, {
      props: {
        open: true,
        task: null,
        conversations: [],
        busy: false,
        error: ""
      },
      attachTo: document.body
    });
    await flushPromises();
    const dialog = document.body;
    expect(dialog.querySelector<HTMLInputElement>('input[placeholder="每日工作提醒"]')?.maxLength).toBe(120);

    await setValue(dialog, 'input[placeholder="每日工作提醒"]', "工作提醒");
    await setValue(dialog, 'textarea[placeholder="说明任务背景、目标和回复要求"]', "提醒大家提交日报");
    await clickButton(dialog, "Cron 表达式");
    await setValue(dialog, 'input[placeholder="0 9 * * *"]', "0 18 * * 1-5");
    await setValue(dialog, 'input[placeholder="group:10001"]', "group:10001");
    await clickButton(dialog, "添加会话");
    const targetInputs = [...dialog.querySelectorAll<HTMLInputElement>('input[placeholder="group:10001"]')];
    setNativeValue(targetInputs[1]!, "account:qq_arona:group:10002");
    await flushPromises();
    await clickButton(dialog, "保存");

    const submitted = wrapper.emitted("save")?.[0]?.[0];
    expect(submitted).toMatchObject({
      name: "工作提醒",
      context: "提醒大家提交日报",
      schedule: { kind: "cron", expression: "0 18 * * 1-5" },
      targets: [
        { conversationId: "group:10001", mentionUserIds: [] },
        { conversationId: "account:qq_arona:group:10002", mentionUserIds: [] }
      ]
    });
    wrapper.unmount();
  });

  it("supports a one-time callback and rejects an invalid target", async () => {
    const wrapper = mount(ScheduledTaskEditorDialog, {
      props: {
        open: true,
        task: null,
        conversations: [],
        busy: false,
        error: ""
      },
      attachTo: document.body
    });
    await flushPromises();
    const dialog = document.body;

    await setValue(dialog, 'input[placeholder="每日工作提醒"]', "单次提醒");
    await setValue(dialog, 'textarea[placeholder="说明任务背景、目标和回复要求"]', "提醒开会");
    await clickButton(dialog, "单次执行");
    await setValue(dialog, 'input[placeholder="group:10001"]', "web:admin");
    await clickButton(dialog, "保存");

    expect(dialog.textContent).toContain("回调会话 ID 无效");
    expect(wrapper.emitted("save")).toBeUndefined();

    await setValue(dialog, 'input[placeholder="group:10001"]', "private:7");
    await clickButton(dialog, "保存");
    expect(wrapper.emitted("save")?.[0]?.[0]).toMatchObject({
      name: "单次提醒",
      schedule: { kind: "once" },
      targets: [{ conversationId: "private:7", mentionUserIds: [] }]
    });
    wrapper.unmount();
  });

  it("rejects unsafe and over-limit mention ids before saving", async () => {
    const wrapper = mount(ScheduledTaskEditorDialog, {
      props: {
        open: true,
        task: taskWithMentions(["9007199254740992"]),
        conversations: [],
        busy: false,
        error: ""
      },
      attachTo: document.body
    });
    await flushPromises();

    await clickButton(document.body, "保存");
    expect(document.body.textContent).toContain("@ 对象必须使用有效 QQ 号");
    expect(wrapper.emitted("save")).toBeUndefined();

    await wrapper.setProps({
      task: taskWithMentions(Array.from({ length: 21 }, (_, index) => String(index + 1)))
    });
    await flushPromises();
    await clickButton(document.body, "保存");
    expect(document.body.textContent).toContain("每个会话最多添加 20 个 @ 对象");
    expect(wrapper.emitted("save")).toBeUndefined();
    wrapper.unmount();
  });
});

function taskWithMentions(mentionUserIds: string[]): ScheduledTask {
  return {
    id: "daily",
    revision: 1,
    name: "工作提醒",
    enabled: true,
    context: "提醒大家提交日报",
    schedule: { kind: "cron", expression: "0 18 * * 1-5", timezone: "Asia/Shanghai" },
    targets: [{ conversationId: "group:10001", mentionUserIds }],
    permanentRetention: false,
    archived: false,
    director: false,
    canReplayDelivery: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

async function setValue(root: HTMLElement, selector: string, value: string) {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!input) throw new Error(`Missing input: ${selector}`);
  setNativeValue(input, value);
  await flushPromises();
}

function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickButton(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
  await flushPromises();
}
