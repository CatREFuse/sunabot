import { computed, readonly, shallowRef } from "vue";
import type {
  ConfigDoctorApplyResult,
  ConfigDoctorChange,
  ConfigDoctorIssue,
  ConfigDoctorProposal,
  ConfigDoctorProvider,
  ConfigDoctorReport
} from "../types";
import { ApiRequestError, apiRequestUnscoped } from "./useAdminApi";

export function useConfigDoctor() {
  const report = shallowRef<ConfigDoctorReport | null>(null);
  const applyResult = shallowRef<ConfigDoctorApplyResult | null>(null);
  const scanning = shallowRef(false);
  const proposing = shallowRef(false);
  const applying = shallowRef(false);
  const error = shallowRef("");
  const message = shallowRef("");
  let operationId = 0;

  const busy = computed(() => scanning.value || proposing.value || applying.value);

  async function scan(options: { preserveOutcome?: boolean } = {}) {
    if (busy.value) return;
    const requestId = ++operationId;
    scanning.value = true;
    error.value = "";
    if (!options.preserveOutcome) {
      message.value = "";
      applyResult.value = null;
    }
    try {
      const result = parseReport(await apiRequestUnscoped<unknown>("/api/config-doctor/scan"));
      if (requestId !== operationId) return;
      report.value = result;
    } catch (cause) {
      if (requestId !== operationId) return;
      error.value = errorMessage(cause, "配置检查失败");
    } finally {
      if (requestId === operationId) scanning.value = false;
    }
  }

  async function propose() {
    const current = report.value;
    if (!current || !current.ai.available || busy.value) return;
    const requestId = ++operationId;
    proposing.value = true;
    error.value = "";
    message.value = "";
    try {
      const result = parseReport(await apiRequestUnscoped<unknown>("/api/config-doctor/propose", {
        method: "POST",
        body: JSON.stringify({ sourceRevision: current.sourceRevision })
      }));
      if (requestId !== operationId) return;
      report.value = result;
      message.value = "AI 诊断已完成";
    } catch (cause) {
      if (requestId !== operationId) return;
      if (shouldClearProposal(cause)) clearProposal();
      error.value = isRevisionConflict(cause)
        ? "配置已变化，请重新检查。"
        : errorMessage(cause, "AI 诊断失败");
    } finally {
      if (requestId === operationId) proposing.value = false;
    }
  }

  async function apply() {
    const current = report.value;
    const proposal = current?.proposal;
    if (!current || !proposal || busy.value) return;
    const requestId = ++operationId;
    applying.value = true;
    error.value = "";
    message.value = "";
    let refresh = false;
    try {
      const result = parseApplyResult(await apiRequestUnscoped<unknown>("/api/config-doctor/apply", {
        method: "POST",
        body: JSON.stringify({
          proposalId: proposal.id,
          sourceRevision: current.sourceRevision
        })
      }));
      if (requestId !== operationId) return;
      applyResult.value = result;
      clearProposal();
      message.value = "配置已修复";
      refresh = true;
    } catch (cause) {
      if (requestId !== operationId) return;
      if (shouldClearProposal(cause)) clearProposal();
      error.value = isRevisionConflict(cause)
        ? "配置已变化，请重新检查。"
        : errorMessage(cause, "配置修复失败");
    } finally {
      if (requestId === operationId) applying.value = false;
    }
    if (refresh) await scan({ preserveOutcome: true });
  }

  function clearProposal() {
    if (!report.value?.proposal) return;
    const { proposal: _proposal, ...next } = report.value;
    report.value = next;
  }

  return {
    report: readonly(report),
    applyResult: readonly(applyResult),
    scanning: readonly(scanning),
    proposing: readonly(proposing),
    applying: readonly(applying),
    busy,
    error: readonly(error),
    message: readonly(message),
    scan: () => scan(),
    propose,
    apply
  };
}

function isRevisionConflict(error: unknown) {
  return error instanceof ApiRequestError && error.code === "CONFIG_REVISION_CONFLICT";
}

function shouldClearProposal(error: unknown) {
  return isRevisionConflict(error)
    || (error instanceof ApiRequestError && error.code === "CONFIG_DOCTOR_PROPOSAL_EXPIRED");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function parseReport(value: unknown): ConfigDoctorReport {
  const report = record(value);
  const status = report.status;
  if (
    report.schemaVersion !== 1
    || typeof report.generatedAt !== "string"
    || typeof report.sourceRevision !== "string"
    || (status !== "healthy" && status !== "repairable" && status !== "manual")
  ) throw new Error("配置医生响应格式无效。");
  const issues = Array.isArray(report.issues)
    ? report.issues.map(parseIssue).filter((issue): issue is ConfigDoctorIssue => issue != null)
    : [];
  const aiValue = optionalRecord(report.ai);
  const provider = parseProvider(aiValue?.provider);
  const proposal = parseProposal(report.proposal);
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    sourceRevision: report.sourceRevision,
    status,
    issues,
    ...(proposal ? { proposal } : {}),
    ai: {
      available: aiValue?.available === true,
      ...(provider ? { provider } : {})
    }
  };
}

function parseIssue(value: unknown, index: number): ConfigDoctorIssue | undefined {
  const issue = optionalRecord(value);
  if (!issue || typeof issue.path !== "string") return undefined;
  const severity = issue.severity === "error" ? "error" : "warning";
  const source = issue.source === "syntax" || issue.source === "ai" ? issue.source : "rules";
  return {
    id: typeof issue.id === "string" ? issue.id : `CONFIG_ISSUE_${index + 1}`,
    path: issue.path,
    message: typeof issue.message === "string" ? issue.message : "配置项需要检查。",
    severity,
    repairable: issue.repairable === true,
    source
  };
}

function parseProposal(value: unknown): ConfigDoctorProposal | undefined {
  const proposal = optionalRecord(value);
  if (
    !proposal
    || typeof proposal.id !== "string"
    || typeof proposal.sourceRevision !== "string"
    || typeof proposal.expiresAt !== "string"
    || (proposal.risk !== "low" && proposal.risk !== "medium")
    || (proposal.source !== "rules" && proposal.source !== "ai")
  ) return undefined;
  const changes = Array.isArray(proposal.changes)
    ? proposal.changes.map(parseChange).filter((change): change is ConfigDoctorChange => change != null)
    : [];
  return {
    id: proposal.id,
    sourceRevision: proposal.sourceRevision,
    expiresAt: proposal.expiresAt,
    risk: proposal.risk,
    source: proposal.source,
    changes
  };
}

function parseChange(value: unknown): ConfigDoctorChange | undefined {
  const change = optionalRecord(value);
  if (!change || typeof change.path !== "string") return undefined;
  const action = change.action === "remove" || change.action === "replace" ? change.action : "add";
  return {
    path: change.path,
    action,
    summary: typeof change.summary === "string" ? change.summary : `修复字段 ${change.path}`,
    risk: change.risk === "medium" ? "medium" : "low"
  };
}

function parseProvider(value: unknown): ConfigDoctorProvider | undefined {
  const provider = optionalRecord(value);
  if (
    !provider
    || typeof provider.label !== "string"
    || typeof provider.model !== "string"
    || typeof provider.destination !== "string"
  ) return undefined;
  return { label: provider.label, model: provider.model, destination: provider.destination };
}

function parseApplyResult(value: unknown): ConfigDoctorApplyResult {
  const result = record(value);
  if (
    result.ok !== true
    || typeof result.repairId !== "string"
    || typeof result.repairedAt !== "string"
    || typeof result.sourceRevision !== "string"
    || typeof result.backupPath !== "string"
    || !Number.isSafeInteger(result.appliedChanges)
  ) throw new Error("配置修复响应格式无效。");
  return {
    ok: true,
    repairId: result.repairId,
    repairedAt: result.repairedAt,
    sourceRevision: result.sourceRevision,
    backupPath: result.backupPath,
    restartRequired: result.restartRequired === true,
    appliedChanges: result.appliedChanges as number
  };
}

function record(value: unknown) {
  const result = optionalRecord(value);
  if (!result) throw new Error("配置医生响应格式无效。");
  return result;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
