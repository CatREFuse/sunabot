import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount } from "../../types";
import OneBotLoginDialog from "../overview/OneBotLoginDialog.vue";
import AgentAccountList from "./AgentAccountList.vue";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

const createdAt = "2026-07-14T00:00:00.000Z";

function account(input: Pick<AgentAccount, "id" | "agentId" | "label" | "webuiPort">): AgentAccount {
  return {
    ...input,
    enabled: true,
    connected: false,
    runtimeReady: true,
    createdAt,
    updatedAt: createdAt
  };
}

describe("AgentAccountList", () => {
  beforeEach(() => {
    apiRequest.mockReset().mockResolvedValue({ connected: true, online: true, available: true, phase: "online" });
  });

  it("keeps the primary account and allows removing secondary accounts", async () => {
    const wrapper = shallowMount(AgentAccountList, {
      props: {
        agentId: "plana",
        accounts: [
          account({ id: "primary", agentId: "plana", label: "主账号", webuiPort: 6099 }),
          account({ id: "secondary", agentId: "plana", label: "备用账号", webuiPort: 6100 })
        ]
      }
    });

    expect(wrapper.find('button[aria-label="移除 主账号"]').exists()).toBe(false);
    const removeSecondary = wrapper.get('button[aria-label="移除 备用账号"]');
    await removeSecondary.trigger("click");
    expect(wrapper.emitted("remove")).toEqual([["secondary"]]);

    const loginButtons = wrapper.findAll("button").filter((button) => button.text() === "登录");
    await loginButtons[1].trigger("click");
    await flushPromises();
    expect(wrapper.getComponent(OneBotLoginDialog).props()).toMatchObject({
      accountId: "secondary",
      accountLabel: "备用账号"
    });
    expect(apiRequest).toHaveBeenCalledWith("/api/agents/plana/accounts/secondary/login/status");
  });

  it("shows a run action for a newly registered container before runtime state is ready", async () => {
    const pending = account({ id: "secondary", agentId: "plana", label: "备用账号", webuiPort: 6100 });
    pending.runtimeReady = false;
    pending.desiredState = "running";
    pending.observedState = "missing";
    pending.reconcileRequired = false;
    const wrapper = shallowMount(AgentAccountList, {
      props: { agentId: "plana", accounts: [pending] }
    });

    expect(wrapper.text()).toContain("新建 NapCat QQ Docker");
    expect(wrapper.text()).toContain("未运行");
    const run = wrapper.findAll("button").find((button) => button.text() === "运行");
    expect(run).toBeDefined();
    expect(run?.attributes("disabled")).toBeUndefined();
    await run?.trigger("click");
    expect(wrapper.emitted("run")).toEqual([["secondary"]]);
  });

  it("keeps the run action available after a stable reconciliation failure", () => {
    const failed = account({ id: "secondary", agentId: "plana", label: "备用账号", webuiPort: 6100 });
    failed.runtimeReady = false;
    failed.desiredState = "running";
    failed.observedState = "missing";
    failed.reconcileRequired = true;
    failed.lastError = "Docker Engine 不可用";
    const wrapper = shallowMount(AgentAccountList, {
      props: { agentId: "plana", accounts: [failed] }
    });

    expect(wrapper.text()).toContain("需要处理");
    expect(wrapper.text()).toContain("备用账号：Docker Engine 不可用");
    expect(wrapper.findAll("button").some((button) => button.text() === "运行")).toBe(true);
    expect(wrapper.text()).not.toContain("重启后登录");
  });
});
