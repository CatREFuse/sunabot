<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";
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
const barkPlaceholder = computed(() => configured.value
  ? "••••••••（已配置，输入新地址可替换）"
  : "https://api.day.app/你的设备密钥");

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
    message.value = "设置已保存。";
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
        <h3 class="mt-2 text-lg font-medium text-display">通知与连接监控</h3>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-mute">设置 Bark 后，连接异常与服务异常会自动合并提醒，减少重复消息。</p>
      </div>
      <span class="inline-state" :data-kind="configured ? 'success' : 'warning'">{{ configured ? "[已配置]" : "[未配置]" }}</span>
    </div>

    <div class="mt-5 grid gap-5 sm:grid-cols-2">
      <label class="field sm:col-span-2">
        <span class="field-label">Bark URL</span>
        <input v-model.trim="form.barkUrl" class="control" type="password" autocomplete="new-password" :placeholder="barkPlaceholder">
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
      <ToggleSwitch v-model="form.onebotEventsEnabled" label="QQ 连接状态" description="持续掉线超过宽限时间后提醒，恢复连接时再次提醒。" />
      <ToggleSwitch v-model="form.serverEventsEnabled" label="服务运行状态" description="服务启动、停止或发生异常时提醒。" />
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
