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
  const remainingSeconds = shallowRef(0);
  const qrBlocked = shallowRef(true);
  let expiryTimer: number | undefined;
  let refreshVersion = 0;
  let pollTimer: number | undefined;
  let pollController: AbortController | undefined;
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
    checking.value = false;
    confirmingLogout.value = false;
    error.value = "";
    blockQr();
    document.addEventListener("visibilitychange", onVisibilityChange);
    cancelStatusPoll();
    busy.value = true;
    const currentSession = ++session;
    let refreshAfterStatus = false;
    try {
      activePaths = resolvePaths();
      const current = await apiRequest<OneBotQrLogin>(activePaths.status);
      if (!isCurrent(currentSession)) return;
      await applySnapshot({ ...current, imageDataUrl: undefined, imageUrl: undefined, qrcode: undefined });
      if (!isCurrent(currentSession)) return;
      refreshAfterStatus = !current.online && !current.authenticated;
      if (current.authenticated && !current.online) startPolling();
    } catch (cause) {
      if (!isCurrent(currentSession)) return;
      error.value = errorMessage(cause, "QQ 登录状态读取失败");
      refreshAfterStatus = true;
    } finally {
      if (isCurrent(currentSession)) busy.value = false;
    }
    if (refreshAfterStatus && isCurrent(currentSession)) await refreshQrCode();
  }

  async function refreshQrCode() {
    if (!open.value || busy.value) return;
    const currentSession = session;
    const requestPaths = activePaths ?? resolvePaths();
    cancelStatusPoll();
    blockQr();
    busy.value = true;
    error.value = "";
    try {
      const next = await apiRequest<OneBotQrLogin>(requestPaths.login, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (!isCurrent(currentSession)) return;
      qrBlocked.value = false;
      await applySnapshot(next);
      if (isCurrent(currentSession) && !next.online) startPolling();
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
    cancelStatusPoll();
    busy.value = true;
    error.value = "";
    try {
      const next = await apiRequest<OneBotQrLogin>(requestPaths.logout, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (!isCurrent(currentSession)) return;
      confirmingLogout.value = false;
      qrBlocked.value = false;
      await applySnapshot(next);
      if (isCurrent(currentSession)) startPolling(1_000);
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
    blockQr();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    cancelStatusPoll();
  }

  function startPolling(delayMs = LOGIN_POLL_INTERVAL_MS) {
    stopPolling();
    if (!open.value || snapshot.value?.online || document.visibilityState !== "visible") return;
    pollTimer = window.setTimeout(() => void pollStatus(), delayMs);
  }

  async function pollStatus(recheckOnline = false) {
    stopPolling();
    if (!open.value || busy.value || checking.value || document.visibilityState !== "visible"
      || (snapshot.value?.online && !recheckOnline)) return;
    const currentSession = session;
    const currentRefresh = refreshVersion;
    const requestPaths = activePaths ?? resolvePaths();
    pollController = new AbortController();
    checking.value = true;
    try {
      const next = await apiRequest<OneBotQrLogin>(requestPaths.status, { signal: pollController.signal });
      if (!isCurrent(currentSession) || currentRefresh !== refreshVersion) return;
      updateExpiry();
      await applySnapshot(next);
      if (!isCurrent(currentSession) || currentRefresh !== refreshVersion) return;
      if (!qrBlocked.value || next.online) error.value = next.error ?? "";
    } catch (cause) {
      if (!isCurrent(currentSession) || currentRefresh !== refreshVersion) return;
      blockQr();
      if (snapshot.value?.phase !== "restarting") {
        error.value = errorMessage(cause, "登录状态读取失败");
      }
    } finally {
      if (isCurrent(currentSession) && currentRefresh === refreshVersion) {
        pollController = undefined;
        checking.value = false;
        startPolling();
      }
    }
  }

  function cancelStatusPoll() {
    refreshVersion += 1;
    pollController?.abort();
    pollController = undefined;
    checking.value = false;
    stopPolling();
  }

  function onVisibilityChange() {
    updateExpiry();
    if (document.visibilityState === "visible") void pollStatus(true);
    else cancelStatusPoll();
  }

  async function applySnapshot(next: OneBotQrLogin) {
    const currentSession = session;
    const becameOnline = snapshot.value?.online !== true && next.online;
    snapshot.value = next;
    updateExpiry();
    if (!qrBlocked.value && remainingSeconds.value > 0 && !expiryTimer) {
      expiryTimer = window.setInterval(updateExpiry, 250);
    }
    options.onStatus?.(next);
    if (!isCurrent(currentSession)) return;
    if (next.online) {
      stopPolling();
      blockQr();
      if (becameOnline) await options.onOnline?.(next);
    }
  }

  function blockQr() {
    qrBlocked.value = true;
    remainingSeconds.value = 0;
    if (expiryTimer) window.clearInterval(expiryTimer);
    expiryTimer = undefined;
  }

  function updateExpiry() {
    if (qrBlocked.value) return;
    const next = snapshot.value;
    const expiresAt = Date.parse(next?.imageExpiresAt ?? "");
    if (next?.phase === "expired" || next?.error || next?.loginError) {
      blockQr();
      return;
    }
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
      remainingSeconds.value = 0;
      // Restart recovery may still be waiting for its first QR image.
      if (Number.isFinite(expiresAt) || (next?.phase !== "restarting" && next?.phase !== "starting")) blockQr();
      return;
    }
    remainingSeconds.value = Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000));
    if (remainingSeconds.value === 0) blockQr();
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
    remainingSeconds: readonly(remainingSeconds),
    qrBlocked: readonly(qrBlocked),
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
