<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, toRaw } from "vue";
import { apiRequest } from "../../composables/useAdminApi";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import SettingsConfirmInput from "./SettingsConfirmInput.vue";

interface MonitoringSettings {
  barkConfigured: boolean;
  aggregationWindowSeconds: number;
  onebotOfflineGraceSeconds: number;
  heartbeatStaleSeconds: number;
  serverEventsEnabled: boolean;
  onebotEventsEnabled: boolean;
}

const form = reactive({
  barkUrl: "",
  clearBarkUrl: false,
  aggregationWindowSeconds: 60,
  onebotOfflineGraceSeconds: 20,
  heartbeatStaleSeconds: 120,
  serverEventsEnabled: true,
  onebotEventsEnabled: true
});
const configured = shallowRef(false);
const testing = shallowRef(false);
const message = shallowRef("");
const error = shallowRef("");
let baseline = snapshot();
let loaded = false;
let pending = false;
let savePromise: Promise<void> | undefined;
const controller = new AbortController();
const barkPlaceholder = computed(() => configured.value
  ? "••••••••（已配置，输入新地址可替换）"
  : "https://api.day.app/你的设备密钥");

onMounted(() => void load());
onBeforeUnmount(cancel);

async function load() {
  try {
    apply(await apiRequest<MonitoringSettings>("/api/monitoring/settings", { signal: controller.signal }));
    loaded = true;
    error.value = "";
  } catch (reason) {
    error.value = errorMessage(reason, "读取监控设置失败");
  }
}

function commit() {
  if (!loaded || !isDirty()) return Promise.resolve();
  pending = true;
  error.value = "";
  return drain();
}

function drain() {
  if (savePromise) return savePromise;
  const running = savePending().finally(() => {
    if (savePromise === running) savePromise = undefined;
  });
  savePromise = running;
  return running;
}

async function savePending() {
  while (pending && !controller.signal.aborted) {
    pending = false;
    if (!isDirty()) continue;
    const submitted = snapshot();
    error.value = "";
    try {
      const result = await apiRequest<MonitoringSettings>("/api/monitoring/settings", {
        method: "PUT",
        body: JSON.stringify(submitted),
        signal: controller.signal
      });
      baseline = baselineFrom(result);
      configured.value = result.barkConfigured;
      if (JSON.stringify(snapshot()) === JSON.stringify(submitted)) apply(result);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      error.value = errorMessage(reason, "保存监控设置失败");
    }
  }
}

async function flush() {
  if (!loaded) return true;
  if (isDirty()) pending = true;
  await drain();
  return !isDirty();
}

function cancel() {
  pending = false;
  controller.abort();
}

async function testNotification() {
  testing.value = true;
  try {
    await apiRequest("/api/monitoring/test", { method: "POST" });
    message.value = "测试通知已发送。";
    error.value = "";
  } catch (reason) {
    error.value = errorMessage(reason, "发送测试通知失败");
  } finally {
    testing.value = false;
  }
}

function apply(settings: MonitoringSettings) {
  configured.value = settings.barkConfigured;
  form.barkUrl = "";
  form.clearBarkUrl = false;
  form.aggregationWindowSeconds = settings.aggregationWindowSeconds;
  form.onebotOfflineGraceSeconds = settings.onebotOfflineGraceSeconds;
  form.heartbeatStaleSeconds = settings.heartbeatStaleSeconds;
  form.serverEventsEnabled = settings.serverEventsEnabled;
  form.onebotEventsEnabled = settings.onebotEventsEnabled;
  baseline = snapshot();
}

function handleChange(event: Event) {
  if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") void commit();
}

function baselineFrom(settings: MonitoringSettings) {
  return {
    barkUrl: "",
    clearBarkUrl: false,
    aggregationWindowSeconds: settings.aggregationWindowSeconds,
    onebotOfflineGraceSeconds: settings.onebotOfflineGraceSeconds,
    heartbeatStaleSeconds: settings.heartbeatStaleSeconds,
    serverEventsEnabled: settings.serverEventsEnabled,
    onebotEventsEnabled: settings.onebotEventsEnabled
  };
}

function snapshot() {
  return JSON.parse(JSON.stringify(toRaw(form))) as typeof form;
}

function isDirty() {
  return JSON.stringify(snapshot()) !== JSON.stringify(baseline);
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

defineExpose({ flush, cancel });
</script>

<template>
  <section class="grid gap-8" @change="handleChange">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="section-title">通知与连接监控</h2>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-mute">设置 Bark 后，连接异常与服务异常会自动合并提醒，减少重复消息。</p>
      </div>
      <span class="inline-state" :data-kind="configured ? 'success' : 'warning'">{{ configured ? "已配置" : "未配置" }}</span>
    </div>

    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field sm:col-span-2">
        <span class="field-label">Bark URL</span>
        <SettingsConfirmInput v-model.trim="form.barkUrl" type="password" autocomplete="new-password" :placeholder="barkPlaceholder" confirm-label="确认 Bark URL" @confirm="commit" />
      </label>
      <label class="field">
        <span class="field-label">聚合窗口（秒）</span>
        <SettingsConfirmInput v-model.number="form.aggregationWindowSeconds" type="number" min="5" max="600" confirm-label="确认聚合窗口" @confirm="commit" />
      </label>
      <label class="field">
        <span class="field-label">断线宽限（秒）</span>
        <SettingsConfirmInput v-model.number="form.onebotOfflineGraceSeconds" type="number" min="0" max="600" confirm-label="确认断线宽限" @confirm="commit" />
      </label>
      <label class="field">
        <span class="field-label">心跳超时（秒）</span>
        <SettingsConfirmInput v-model.number="form.heartbeatStaleSeconds" type="number" min="30" max="3600" confirm-label="确认心跳超时" @confirm="commit" />
      </label>
      <label class="flex items-center gap-2 self-end pb-3 text-sm text-mute">
        <input v-model="form.clearBarkUrl" type="checkbox">
        清除已保存的 Bark URL
      </label>
    </div>

    <div class="divide-y divide-line border-y border-line">
      <ToggleSwitch v-model="form.onebotEventsEnabled" label="QQ 连接状态" description="持续掉线超过宽限时间后提醒，恢复连接时再次提醒。" />
      <ToggleSwitch v-model="form.serverEventsEnabled" label="服务运行状态" description="服务启动、停止或发生异常时提醒。" />
    </div>

    <div v-if="error" class="flex flex-wrap items-center gap-3">
      <p class="inline-state" data-kind="error">{{ error }}</p>
      <button class="btn btn-ghost" type="button" @click="commit">重试</button>
    </div>
    <p v-else-if="message" class="inline-state" data-kind="success">{{ message }}</p>
    <div class="flex flex-wrap gap-2">
      <button class="btn btn-ghost" type="button" :disabled="testing || !configured" @click="testNotification">发送测试通知</button>
    </div>
  </section>
</template>
