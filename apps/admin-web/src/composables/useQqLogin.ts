import { computed, onBeforeUnmount, readonly, shallowRef } from "vue";
import type { OneBotQrLogin } from "../types";
import { apiRequest } from "./useAdminApi";

const LOGIN_POLL_INTERVAL_MS = 2_000;

interface UseQqLoginOptions {
  onStatus?: (snapshot: OneBotQrLogin) => void;
  onOnline?: (snapshot: OneBotQrLogin) => void | Promise<void>;
  paths?: () => { status: string; login: string; logout: string };
}

type QqLoginPaths = ReturnType<NonNullable<UseQqLoginOptions["paths"]>>;

export function useQqLogin(options: UseQqLoginOptions = {}) {
  const open = shallowRef(false);
  const busy = shallowRef(false);
  const checking = shallowRef(false);
  const confirmingLogout = shallowRef(false);
  const snapshot = shallowRef<OneBotQrLogin | null>(null);
  const error = shallowRef("");
  let pollTimer: number | undefined;
  let session = 0;
  let activePaths: QqLoginPaths | undefined;

  const online = computed(() => snapshot.value?.online === true);
  const resolvePaths = () => options.paths?.() ?? {
    status: "/api/onebot/qq-login/status",
    login: "/api/onebot/qq-login",
    logout: "/api/onebot/qq-logout"
  };

  async function openDialog() {
    open.value = true;
    snapshot.value = null;
    confirmingLogout.value = false;
    error.value = "";
    stopPolling();
    busy.value = true;
    const currentSession = ++session;
    let refreshAfterStatus = false;
    try {
      activePaths = resolvePaths();
      const current = await apiRequest<OneBotQrLogin>(activePaths.status);
      if (!isCurrent(currentSession)) return;
      await applySnapshot(current);
      refreshAfterStatus = !current.online;
    } catch (cause) {
      if (!isCurrent(currentSession)) return;
      error.value = errorMessage(cause, "QQ 登录状态读取失败");
      startPolling();
    } finally {
      if (isCurrent(currentSession)) busy.value = false;
    }
    if (refreshAfterStatus && isCurrent(currentSession)) await refreshQrCode();
  }

  async function refreshQrCode() {
    if (!open.value || busy.value) return;
    const currentSession = session;
    const requestPaths = activePaths ?? resolvePaths();
    busy.value = true;
    error.value = "";
    try {
      const next = await apiRequest<OneBotQrLogin>(requestPaths.login, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (!isCurrent(currentSession)) return;
      await applySnapshot(next);
      if (!next.online) startPolling();
    } catch (cause) {
      if (!isCurrent(currentSession)) return;
      error.value = errorMessage(cause, "二维码刷新失败");
      startPolling();
    } finally {
      if (isCurrent(currentSession)) busy.value = false;
    }
  }

  function requestLogout() {
    confirmingLogout.value = true;
  }

  function cancelLogout() {
    confirmingLogout.value = false;
  }

  async function logout() {
    if (!open.value || busy.value) return;
    const currentSession = session;
    const requestPaths = activePaths ?? resolvePaths();
    busy.value = true;
    error.value = "";
    try {
      const next = await apiRequest<OneBotQrLogin>(requestPaths.logout, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (!isCurrent(currentSession)) return;
      confirmingLogout.value = false;
      await applySnapshot(next);
      startPolling(1_000);
    } catch (cause) {
      if (!isCurrent(currentSession)) return;
      error.value = errorMessage(cause, "QQ 退出失败");
    } finally {
      if (isCurrent(currentSession)) busy.value = false;
    }
  }

  function closeDialog() {
    session += 1;
    open.value = false;
    busy.value = false;
    checking.value = false;
    confirmingLogout.value = false;
    activePaths = undefined;
    stopPolling();
  }

  function startPolling(delayMs = LOGIN_POLL_INTERVAL_MS) {
    stopPolling();
    if (!open.value || snapshot.value?.online) return;
    pollTimer = window.setTimeout(() => void pollStatus(), delayMs);
  }

  async function pollStatus() {
    pollTimer = undefined;
    if (!open.value || checking.value || snapshot.value?.online) return;
    const currentSession = session;
    const requestPaths = activePaths ?? resolvePaths();
    checking.value = true;
    let refreshExpired = false;
    try {
      const next = await apiRequest<OneBotQrLogin>(requestPaths.status);
      if (!isCurrent(currentSession)) return;
      await applySnapshot(next);
      error.value = next.error ?? "";
      refreshExpired = next.phase === "expired";
    } catch (cause) {
      if (!isCurrent(currentSession)) return;
      if (snapshot.value?.phase !== "restarting") {
        error.value = errorMessage(cause, "登录状态读取失败");
      }
    } finally {
      if (isCurrent(currentSession)) checking.value = false;
      if (isCurrent(currentSession) && !snapshot.value?.online) {
        if (refreshExpired) void refreshQrCode();
        else startPolling();
      }
    }
  }

  async function applySnapshot(next: OneBotQrLogin) {
    const becameOnline = snapshot.value?.online !== true && next.online;
    snapshot.value = next;
    options.onStatus?.(next);
    if (next.online) {
      stopPolling();
      if (becameOnline) await options.onOnline?.(next);
    }
  }

  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function isCurrent(value: number) {
    return open.value && value === session;
  }

  onBeforeUnmount(closeDialog);

  return {
    open: readonly(open),
    busy: readonly(busy),
    checking: readonly(checking),
    confirmingLogout: readonly(confirmingLogout),
    snapshot: readonly(snapshot),
    error: readonly(error),
    online,
    openDialog,
    closeDialog,
    refreshQrCode,
    requestLogout,
    cancelLogout,
    logout
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
