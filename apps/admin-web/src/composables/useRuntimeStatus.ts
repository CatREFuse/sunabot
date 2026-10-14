import { readonly, shallowRef, watch } from "vue";
import { ApiRequestError, apiRequest } from "./useAdminApi";
import { activeAgentId, activeAgentIdState } from "./agentScope";
import type { RuntimeStatus } from "../types";

const status = shallowRef<RuntimeStatus | null>(null);
const loading = shallowRef(false);
const error = shallowRef("");
let timer: number | undefined;
let controller: AbortController | undefined;
let started = false;
let refreshId = 0;
let pending: Promise<void> | undefined;
let requestAgentId = "";
let stopAgentWatch: (() => void) | undefined;

function refresh(): Promise<void> {
  const agentId = activeAgentId();
  if (pending && requestAgentId === agentId) return pending;
  requestAgentId = agentId;
  const requestId = ++refreshId;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  if (timer) window.clearTimeout(timer);
  loading.value = true;
  pending = readStatus(requestId, agentId, signal);
  return pending;
}

async function readStatus(requestId: number, agentId: string, signal: AbortSignal) {
  try {
    const result = await apiRequest<RuntimeStatus>(`/api/status?agentId=${encodeURIComponent(agentId)}`, { signal });
    if (requestId !== refreshId) return;
    status.value = result;
    error.value = "";
  } catch (caught) {
    if (requestId !== refreshId || (caught instanceof DOMException && caught.name === "AbortError")) return;
    status.value = null;
    if (!(caught instanceof ApiRequestError && caught.status === 401)) {
      error.value = caught instanceof Error ? caught.message : "状态读取失败";
    }
  } finally {
    if (requestId === refreshId) {
      loading.value = false;
      pending = undefined;
      if (started) schedule();
    }
  }
}

function schedule() {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (document.visibilityState === "visible") void refresh();
    else schedule();
  }, 10_000);
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") void refresh();
}

function start() {
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  stopAgentWatch = watch(activeAgentIdState, () => {
    status.value = null;
    error.value = "";
    void refresh();
  });
  void refresh();
}

function stop() {
  if (!started) return;
  started = false;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopAgentWatch?.();
  stopAgentWatch = undefined;
  if (timer) window.clearTimeout(timer);
  timer = undefined;
  controller?.abort();
  refreshId += 1;
  pending = undefined;
  loading.value = false;
}

export function useRuntimeStatus() {
  return { status: readonly(status), loading: readonly(loading), error: readonly(error), refresh, start, stop };
}
