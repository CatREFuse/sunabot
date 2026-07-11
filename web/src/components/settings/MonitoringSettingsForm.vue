<script setup lang="ts">
import { onMounted, reactive, shallowRef } from "vue";
import { apiRequest } from "../../composables/useAdminApi";
import ToggleSwitch from "../ui/ToggleSwitch.vue";

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
const busy = shallowRef(false);
const testing = shallowRef(false);
const message = shallowRef("");
const error = shallowRef("");

onMounted(() => void load());

async function load() {
  try {
    apply(await apiRequest<MonitoringSettings>("/api/monitoring/settings"));
    error.value = "";
  } catch (reason) {
    error.value = errorMessage(reason, "读取监控设置失败");
  }
}

async function save() {
  busy.value = true;
  try {
    const result = await apiRequest<MonitoringSettings>("/api/monitoring/settings", {
      method: "PUT",
      body: JSON.stringify(form)
    });
    apply(result);
    message.value = "设置已保存到 workspace/.env。";
    error.value = "";
  } catch (reason) {
    error.value = errorMessage(reason, "保存监控设置失败");
  } finally {
    busy.value = false;
  }
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
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
</script>

<template>
  <section class="rounded-xl border border-visible bg-panel p-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="page-kicker">SERVICE MONITOR</p>
        <h3 class="mt-2 text-lg font-medium text-display">Bark 与 OneBot 监控</h3>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-mute">Bark 地址只保存在 workspace/.env，页面和 API 都不会回显。OneBot 断线与服务器事件分开聚合发送。</p>
      </div>
      <span class="inline-state" :data-kind="configured ? 'success' : 'warning'">{{ configured ? "[BARK CONFIGURED]" : "[BARK MISSING]" }}</span>
    </div>

    <div class="mt-5 grid gap-5 sm:grid-cols-2">
      <label class="field sm:col-span-2">
        <span class="field-label">Bark URL</span>
        <input v-model.trim="form.barkUrl" class="control" type="password" autocomplete="new-password" placeholder="留空则保留现有地址">
      </label>
      <label class="field">
        <span class="field-label">聚合窗口（秒）</span>
        <input v-model.number="form.aggregationWindowSeconds" class="control" type="number" min="5" max="600">
      </label>
      <label class="field">
        <span class="field-label">断线宽限（秒）</span>
        <input v-model.number="form.onebotOfflineGraceSeconds" class="control" type="number" min="0" max="600">
      </label>
      <label class="field">
        <span class="field-label">心跳超时（秒）</span>
        <input v-model.number="form.heartbeatStaleSeconds" class="control" type="number" min="30" max="3600">
      </label>
      <label class="flex items-center gap-2 self-end pb-3 text-sm text-mute">
        <input v-model="form.clearBarkUrl" type="checkbox">
        清除已保存的 Bark URL
      </label>
    </div>

    <div class="mt-5 divide-y divide-line rounded-lg border border-line px-4">
      <ToggleSwitch v-model="form.onebotEventsEnabled" label="OneBot 连接事件" description="仅依据反向 WebSocket 连接与事件心跳判断，不再嗅探 kickoff 日志。" />
      <ToggleSwitch v-model="form.serverEventsEnabled" label="服务器事件" description="启动、停止与未处理异常使用独立通知组。" />
    </div>

    <p v-if="error" class="mt-4 text-sm text-accent">[ERROR: {{ error }}]</p>
    <p v-else-if="message" class="mt-4 text-sm text-success">{{ message }}</p>
    <div class="mt-5 flex flex-wrap gap-2">
      <button class="btn" type="button" :disabled="busy" @click="save">保存监控设置</button>
      <button class="btn btn-ghost" type="button" :disabled="testing || !configured" @click="testNotification">发送测试通知</button>
      <button class="btn btn-ghost" type="button" :disabled="busy" @click="load">刷新</button>
    </div>
  </section>
</template>
