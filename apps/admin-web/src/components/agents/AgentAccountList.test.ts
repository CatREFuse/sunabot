import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentAccount } from "../../types";
import AgentAccountList from "./AgentAccountList.vue";

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
  });
});
