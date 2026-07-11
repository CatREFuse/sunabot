import { readonly, shallowRef } from "vue";
import { ApiRequestError, apiRequest } from "./useAdminApi";
import type { RuntimeStatus } from "../types";

const status = shallowRef<RuntimeStatus | null>(null);
const loading = shallowRef(false);
const error = shallowRef("");
let timer: number | undefined;
let controller: AbortController | undefined;
let started = false;
let refreshId = 0;

async function refresh() {
  const requestId = ++refreshId;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  try {
    const result = await apiRequest<RuntimeStatus>("/api/status", { signal: controller.signal });
    if (requestId !== refreshId) return;
    status.value = result;
    error.value = "";
  } catch (caught) {
    if (requestId !== refreshId || (caught instanceof DOMException && caught.name === "AbortError")) return;
    if (!(caught instanceof ApiRequestError && caught.status === 401)) {
      error.value = caught instanceof Error ? caught.message : "状态读取失败";
    }
  } finally {
    if (requestId === refreshId) loading.value = false;
  }
}

function schedule() {
  if (timer) window.clearInterval(timer);
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 10_000);
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") void refresh();
}

function start() {
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  schedule();
  void refresh();
}

function stop() {
  if (!started) return;
  started = false;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (timer) window.clearInterval(timer);
  timer = undefined;
  controller?.abort();
}

export function useRuntimeStatus() {
  return { status: readonly(status), loading: readonly(loading), error: readonly(error), refresh, start, stop };
}
