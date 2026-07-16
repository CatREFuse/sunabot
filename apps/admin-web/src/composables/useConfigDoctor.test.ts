import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigDoctorApplyResult, ConfigDoctorReport } from "../types";
import { ApiRequestError } from "./useAdminApi";
import { useConfigDoctor } from "./useConfigDoctor";

const apiRequestUnscoped = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useAdminApi")>();
  return { ...original, apiRequestUnscoped };
});

let wrapper: ReturnType<typeof mount> | undefined;

beforeEach(() => apiRequestUnscoped.mockReset());
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("useConfigDoctor", () => {
  it("scans the global configuration without invoking AI", async () => {
    apiRequestUnscoped.mockResolvedValueOnce(ruleReport());
    const doctor = mountDoctor();

    await doctor.scan();

    expect(apiRequestUnscoped).toHaveBeenCalledOnce();
    expect(apiRequestUnscoped).toHaveBeenCalledWith("/api/config-doctor/scan");
    expect(doctor.report.value?.status).toBe("repairable");
    expect(doctor.proposing.value).toBe(false);
  });

  it("uses safe defaults when optional report fields are missing", async () => {
    apiRequestUnscoped.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: "2026-07-16T10:00:00.000Z",
      sourceRevision: "revision-1",
      status: "healthy"
    });
    const doctor = mountDoctor();

    await doctor.scan();

    expect(doctor.report.value?.issues).toEqual([]);
    expect(doctor.report.value?.ai).toEqual({ available: false });
    expect(doctor.error.value).toBe("");
  });

  it("shows a stable error for an unsupported response schema", async () => {
    apiRequestUnscoped.mockResolvedValueOnce({ schemaVersion: 2 });
    const doctor = mountDoctor();

    await doctor.scan();

    expect(doctor.report.value).toBeNull();
    expect(doctor.error.value).toBe("配置医生响应格式无效。");
  });

  it("requests an explicit AI proposal with only the source revision", async () => {
    apiRequestUnscoped
      .mockResolvedValueOnce(ruleReport())
      .mockResolvedValueOnce(aiReport());
    const doctor = mountDoctor();
    await doctor.scan();

    await doctor.propose();

    expect(apiRequestUnscoped).toHaveBeenLastCalledWith("/api/config-doctor/propose", {
      method: "POST",
      body: JSON.stringify({ sourceRevision: "revision-1" })
    });
    const request = JSON.parse(apiRequestUnscoped.mock.calls[1]![1].body) as Record<string, unknown>;
    expect(request).toEqual({ sourceRevision: "revision-1" });
    expect(request).not.toHaveProperty("patch");
    expect(doctor.report.value?.proposal?.source).toBe("ai");
    expect(doctor.message.value).toBe("AI 诊断已完成");
  });

  it("applies a server proposal without sending patch content and refreshes the scan", async () => {
    apiRequestUnscoped
      .mockResolvedValueOnce(ruleReport())
      .mockResolvedValueOnce(applyResult())
      .mockResolvedValueOnce(healthyReport());
    const doctor = mountDoctor();
    await doctor.scan();

    await doctor.apply();

    expect(apiRequestUnscoped.mock.calls[1]).toEqual([
      "/api/config-doctor/apply",
      {
        method: "POST",
        body: JSON.stringify({ proposalId: "proposal-rules", sourceRevision: "revision-1" })
      }
    ]);
    const request = JSON.parse(apiRequestUnscoped.mock.calls[1]![1].body) as Record<string, unknown>;
    expect(request).toEqual({ proposalId: "proposal-rules", sourceRevision: "revision-1" });
    expect(request).not.toHaveProperty("patch");
    expect(doctor.applyResult.value?.repairId).toBe("repair-1");
    expect(doctor.applyResult.value?.appliedChanges).toBe(1);
    expect(doctor.report.value?.status).toBe("healthy");
    expect(doctor.message.value).toBe("配置已修复");
  });

  it("drops a stale proposal when the source revision changes", async () => {
    apiRequestUnscoped
      .mockResolvedValueOnce(ruleReport())
      .mockRejectedValueOnce(new ApiRequestError("配置已变化", {
        status: 409,
        code: "CONFIG_REVISION_CONFLICT"
      }));
    const doctor = mountDoctor();
    await doctor.scan();

    await doctor.apply();

    expect(doctor.report.value?.proposal).toBeUndefined();
    expect(doctor.error.value).toBe("配置已变化，请重新检查。");
  });
});

function mountDoctor() {
  let doctor!: ReturnType<typeof useConfigDoctor>;
  const Harness = defineComponent({
    setup() {
      doctor = useConfigDoctor();
      return () => h("div");
    }
  });
  wrapper = mount(Harness);
  return doctor;
}

function ruleReport(): ConfigDoctorReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-16T10:00:00.000Z",
    sourceRevision: "revision-1",
    status: "repairable",
    issues: [{
      id: "missing-normal-reply",
      path: "/normalReply",
      message: "缺少回复重试设置。",
      severity: "warning",
      repairable: true,
      source: "rules"
    }],
    proposal: {
      id: "proposal-rules",
      sourceRevision: "revision-1",
      expiresAt: "2026-07-16T10:10:00.000Z",
      risk: "low",
      source: "rules",
      changes: [{
        path: "/normalReply",
        action: "add",
        summary: "补充回复重试默认设置。",
        risk: "low"
      }]
    },
    ai: {
      available: true,
      provider: {
        label: "OpenAI API",
        model: "gpt-5.5",
        destination: "api.openai.com"
      }
    }
  };
}

function aiReport(): ConfigDoctorReport {
  const report = ruleReport();
  return {
    ...report,
    issues: report.issues.map((issue) => ({ ...issue, source: "ai" as const })),
    proposal: report.proposal ? { ...report.proposal, id: "proposal-ai", source: "ai" } : undefined
  };
}

function healthyReport(): ConfigDoctorReport {
  return {
    ...ruleReport(),
    generatedAt: "2026-07-16T10:01:00.000Z",
    sourceRevision: "revision-2",
    status: "healthy",
    issues: [],
    proposal: undefined
  };
}

function applyResult(): ConfigDoctorApplyResult {
  return {
    ok: true,
    repairId: "repair-1",
    repairedAt: "2026-07-16T10:00:30.000Z",
    sourceRevision: "revision-2",
    backupPath: "backups/config-doctor/repair-1/before.json",
    restartRequired: false,
    appliedChanges: 1
  };
}
