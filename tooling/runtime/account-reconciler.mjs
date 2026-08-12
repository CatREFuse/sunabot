export const ACCOUNT_RUNTIME_STATE_SCHEMA_VERSION = 1;

export function planAccountReconciliation(input) {
  const accountId = validAccountId(input.accountId);
  const account = input.account?.id === accountId ? input.account : undefined;
  const desiredState = account?.enabled === true && account?.agentEnabled === true ? "running" : "stopped";
  const targets = (input.containers ?? []).filter((container) => container.accountId === accountId);
  const running = targets.some((container) => container.state === "running");
  const observedState = running ? "running" : targets.length > 0 ? "stopped" : "missing";
  const action = desiredState === "running"
    ? input.forceRestart === true && running ? "restart" : running ? "verify" : "start"
    : targets.length > 0 ? "remove" : "noop";
  return {
    accountId,
    desiredState,
    observedState,
    action,
    targetContainerIds: targets.map((container) => container.id),
    reconcileRequired: desiredState === "running" ? !running || action === "restart" : targets.length > 0
  };
}

export function accountRuntimeState(input, now = new Date()) {
  return {
    schemaVersion: ACCOUNT_RUNTIME_STATE_SCHEMA_VERSION,
    accountId: validAccountId(input.accountId),
    desiredState: input.desiredState === "stopped" ? "stopped" : "running",
    observedState: ["running", "stopped", "missing", "unknown"].includes(input.observedState)
      ? input.observedState
      : "unknown",
    reconcileRequired: input.reconcileRequired === true,
    lastError: typeof input.lastError === "string" && input.lastError.trim() ? input.lastError.trim().slice(0, 1_000) : null,
    updatedAt: now.toISOString()
  };
}

function validAccountId(value) {
  const accountId = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new Error("QQ 账号 ID 无效。");
  return accountId;
}
