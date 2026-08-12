<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DynamicCursor, { type DynamicCursorMode } from "../components/design-demo/DynamicCursor.vue";
import QuasarSegmented, { type QuasarSegmentedOption } from "../components/design-demo/QuasarSegmented.vue";
import { useTheme, type ThemePreference } from "../composables/useTheme";

type DemoPanel = "overview" | "settings";

const route = useRoute();
const router = useRouter();
const theme = useTheme();
const cursorMode = ref<DynamicCursorMode>("follow");
const compactMode = ref("off");
const routeMotion = ref("on");
const command = ref("");
const commandStatus = ref("");
const transitionName = ref("quasar-slide-forward");
const panelDepth: Record<DemoPanel, number> = { overview: 0, settings: 1 };
const currentPanel = computed<DemoPanel>(() => route.params.panel === "settings" ? "settings" : "overview");

const themeOptions: readonly QuasarSegmentedOption[] = [
  { label: "亮色", value: "light" },
  { label: "暗色", value: "dark" },
  { label: "跟随系统", value: "system" }
];
const cursorOptions: readonly QuasarSegmentedOption[] = [
  { label: "圆点", value: "dot" },
  { label: "圆点跟随", value: "follow" },
  { label: "系统", value: "system" }
];
const binaryOptions: readonly QuasarSegmentedOption[] = [
  { label: "开", value: "on" },
  { label: "关", value: "off" }
];
const quickActions = [
  { label: "状态", icon: "bx-pulse", to: "/overview" },
  { label: "Web Chat", icon: "bx-chat", to: "/web-chat" },
  { label: "会话", icon: "bx-message-square-dots", to: "/conversations" },
  { label: "记忆", icon: "bx-brain", to: "/memory" },
  { label: "知识库", icon: "bx-book-open", to: "/knowledge" },
  { label: "图像", icon: "bx-image", to: "/images" },
  { label: "提示词", icon: "bx-bot", to: "/agent-prompts" },
  { label: "扩展", icon: "bx-extension", to: "/extensions" }
] as const;
const runtimeRows = [
  { label: "OneBot", value: "在线", detail: "1 个连接", icon: "bx-link-alt" },
  { label: "Provider", value: "可用", detail: "gpt-5.6-sol", icon: "bx-cube" },
  { label: "会话", value: "24", detail: "今日 186 条消息", icon: "bx-message-rounded-dots" },
  { label: "记忆", value: "128", detail: "最近更新 2 分钟前", icon: "bx-brain" }
] as const;

watch(currentPanel, (next, previous) => {
  transitionName.value = panelDepth[next] < panelDepth[previous]
    ? "quasar-slide-back"
    : "quasar-slide-forward";
});

function setTheme(value: string) {
  theme.setTheme(value as ThemePreference);
}

function openPanel(panel: DemoPanel) {
  if (panel === currentPanel.value) return;
  void router.push(panel === "settings" ? "/design-demo/settings" : "/design-demo");
}

function runCommand() {
  const value = command.value.trim();
  commandStatus.value = value ? `正在查找“${value}”` : "请输入关键词";
}
</script>

<template>
  <div class="page-shell quasar-demo-shell quasar-scope">
    <DynamicCursor :mode="cursorMode" />
    <i class="quasar-watermark bx bx-bot" aria-hidden="true"></i>

    <div class="quasar-frame">
      <Transition :name="routeMotion === 'on' ? transitionName : 'quasar-fade'" mode="out-in">
        <section v-if="currentPanel === 'overview'" key="overview" aria-labelledby="design-demo-title">
          <header class="quasar-brand-row">
            <div>
              <p class="quasar-eyebrow">普拉娜 · 在线</p>
              <h1 id="design-demo-title" class="quasar-brand">Sunabot<span aria-hidden="true">.</span></h1>
            </div>
            <button
              class="quasar-icon-button"
              type="button"
              aria-label="界面设置"
              data-cursor="action"
              @click="openPanel('settings')"
            >
              <i class="bx bxs-cog" aria-hidden="true"></i>
            </button>
          </header>

          <form class="quasar-search" role="search" @submit.prevent="runCommand">
            <i class="bx bx-search-alt-2" aria-hidden="true"></i>
            <label class="sr-only" for="design-demo-command">搜索</label>
            <input
              id="design-demo-command"
              v-model="command"
              type="search"
              placeholder="搜索 Agent、会话或工具"
              autocomplete="off"
            >
            <span class="quasar-command-status" aria-live="polite">{{ commandStatus }}</span>
            <button type="submit" aria-label="搜索" data-cursor="action">
              <i class="bx bx-right-arrow-alt" aria-hidden="true"></i>
            </button>
          </form>

          <nav class="quasar-actions" aria-label="快捷入口">
            <RouterLink
              v-for="action in quickActions"
              :key="action.to"
              :to="action.to"
              class="quasar-chip"
              data-cursor="action"
            >
              <i class="bx" :class="action.icon" aria-hidden="true"></i>
              <span>{{ action.label }}</span>
            </RouterLink>
          </nav>

          <section class="quasar-status-surface" aria-labelledby="runtime-status-title">
            <div class="quasar-status-heading">
              <div>
                <p class="quasar-eyebrow">当前 Agent</p>
                <h2 id="runtime-status-title">运行状态</h2>
              </div>
              <RouterLink to="/overview" class="quasar-text-action" data-cursor="action">
                完整状态
                <i class="bx bx-right-arrow-alt" aria-hidden="true"></i>
              </RouterLink>
            </div>
            <div class="quasar-runtime-grid">
              <article v-for="row in runtimeRows" :key="row.label" class="quasar-runtime-row">
                <i class="bx" :class="row.icon" aria-hidden="true"></i>
                <div>
                  <h3>{{ row.label }}</h3>
                  <p>{{ row.detail }}</p>
                </div>
                <strong>{{ row.value }}</strong>
              </article>
            </div>
          </section>
        </section>

        <section v-else key="settings" class="quasar-settings-surface" aria-labelledby="design-settings-title">
          <header class="quasar-settings-header">
            <button
              class="quasar-icon-button"
              type="button"
              aria-label="返回管理台"
              data-cursor="action"
              @click="openPanel('overview')"
            >
              <i class="bx bx-left-arrow-alt" aria-hidden="true"></i>
            </button>
            <h1 id="design-settings-title">界面设置</h1>
          </header>

          <div class="quasar-setting-list">
            <div class="quasar-setting-row">
              <div>
                <h2>切换外观</h2>
                <p>选择管理台主题</p>
              </div>
              <QuasarSegmented
                :model-value="theme.preference.value"
                label="切换外观"
                :options="themeOptions"
                @update:model-value="setTheme"
              />
            </div>

            <div class="quasar-divider"></div>

            <div class="quasar-group-title">
              <i class="bx bxs-flask" aria-hidden="true"></i>
              <h2>Agent 实验功能</h2>
            </div>

            <div class="quasar-setting-row">
              <div>
                <h3>鼠标特效</h3>
                <p>桌面端可用</p>
              </div>
              <QuasarSegmented v-model="cursorMode" label="鼠标特效" :options="cursorOptions" />
            </div>

            <div class="quasar-setting-row">
              <div>
                <h3>紧凑模式</h3>
                <p>减少页面留白</p>
              </div>
              <QuasarSegmented v-model="compactMode" label="紧凑模式" :options="binaryOptions" />
            </div>

            <div class="quasar-setting-row">
              <div>
                <h3>路由动效</h3>
                <p>页面按层级滑动</p>
              </div>
              <QuasarSegmented v-model="routeMotion" label="路由动效" :options="binaryOptions" />
            </div>

            <div class="quasar-setting-row">
              <div>
                <h3>命令面板</h3>
                <p>快速执行管理动作</p>
              </div>
              <QuasarSegmented model-value="off" label="命令面板" :options="binaryOptions" disabled />
            </div>
          </div>
        </section>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.quasar-scope {
  --quasar-canvas: #f4f4f5;
  --quasar-overlay: #fff;
  --quasar-raised: #f4f4f5;
  --quasar-ink: #27272a;
  --quasar-secondary: #71717a;
  --quasar-tertiary: #a1a1aa;
  --quasar-line: #e4e4e7;
  --quasar-watermark-color: #e4e4e7;
  --quasar-accent: #3b82f6;
  --quasar-motion-ease: cubic-bezier(0.08, 0.58, 0.58, 1);
  position: relative;
  isolation: isolate;
  min-height: 100%;
  background: var(--quasar-canvas);
  color: var(--quasar-ink);
}

:global(:root[data-theme="dark"] .quasar-scope) {
  --quasar-canvas: #18181b;
  --quasar-overlay: #27272a;
  --quasar-raised: #3f3f46;
  --quasar-ink: #fff;
  --quasar-secondary: #a1a1aa;
  --quasar-tertiary: #52525b;
  --quasar-line: #3f3f46;
  --quasar-watermark-color: #27272a;
}

.quasar-demo-shell {
  padding-top: 32px;
}

.quasar-frame {
  position: relative;
  z-index: 1;
  width: min(100%, 880px);
  min-height: 620px;
  margin: 0 auto;
  padding: 24px 0 80px;
}

.quasar-watermark {
  position: fixed;
  right: clamp(-160px, -6vw, -48px);
  bottom: clamp(-120px, -5vw, -48px);
  z-index: 0;
  color: var(--quasar-watermark-color);
  font-size: clamp(420px, 54vw, 780px);
  line-height: 0.8;
  pointer-events: none;
  user-select: none;
}

.quasar-brand-row,
.quasar-settings-header,
.quasar-status-heading,
.quasar-setting-row,
.quasar-runtime-row {
  display: flex;
  align-items: center;
}

.quasar-brand-row {
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.quasar-eyebrow {
  margin: 0 0 4px;
  color: var(--quasar-secondary);
  font-family: var(--font-data);
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.quasar-brand {
  margin: 0;
  color: var(--quasar-ink);
  font-family: var(--font-ui);
  font-size: clamp(48px, 7vw, 76px);
  font-weight: 700;
  letter-spacing: -0.055em;
  line-height: 0.95;
}

.quasar-brand span {
  color: var(--quasar-accent);
}

.quasar-icon-button {
  display: inline-grid;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  place-items: center;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--quasar-secondary);
  transition:
    color 125ms var(--quasar-motion-ease),
    background-color 125ms var(--quasar-motion-ease),
    transform 125ms var(--quasar-motion-ease);
}

.quasar-icon-button:hover {
  background: var(--quasar-overlay);
  color: var(--quasar-ink);
  transform: translateY(-1px);
}

.quasar-icon-button .bx {
  font-size: 30px;
}

.quasar-search {
  position: sticky;
  top: 16px;
  z-index: 10;
  display: flex;
  min-height: 56px;
  align-items: center;
  gap: 8px;
  border: 0.5px solid var(--quasar-line);
  border-radius: 16px;
  padding: 0 8px 0 16px;
  background: var(--quasar-overlay);
}

.quasar-search > .bx {
  flex: 0 0 auto;
  color: var(--quasar-secondary);
  font-size: 24px;
}

.quasar-search input {
  width: 100%;
  min-width: 0;
  height: 48px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--quasar-ink);
  font-size: 16px;
  font-weight: 700;
}

.quasar-search input::placeholder {
  color: var(--quasar-tertiary);
}

.quasar-search input::-webkit-search-cancel-button {
  display: none;
}

.quasar-search button {
  display: inline-grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  place-items: center;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--quasar-ink);
  transition: background-color 125ms var(--quasar-motion-ease);
}

.quasar-search button:hover {
  background: var(--quasar-raised);
}

.quasar-search button .bx {
  font-size: 32px;
}

.quasar-command-status {
  max-width: 180px;
  overflow: hidden;
  color: var(--quasar-secondary);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quasar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}

.quasar-chip {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  gap: 8px;
  border-radius: 16px;
  padding: 0 16px;
  background: var(--quasar-overlay);
  color: var(--quasar-ink);
  font-size: 15px;
  font-weight: 700;
  text-decoration: none;
  transition:
    box-shadow 125ms var(--quasar-motion-ease),
    transform 125ms var(--quasar-motion-ease);
}

.quasar-chip:hover {
  box-shadow: 0 16px 32px rgb(0 0 0 / 16%);
  transform: translateY(-1px);
}

.quasar-chip .bx {
  color: var(--quasar-accent);
  font-size: 24px;
}

.quasar-status-surface,
.quasar-settings-surface {
  border-radius: 24px;
  background: var(--quasar-overlay);
  box-shadow: 0 25px 50px -12px rgb(0 0 0 / 25%);
}

.quasar-status-surface {
  margin-top: 32px;
  padding: 32px;
}

.quasar-status-heading {
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 24px;
}

.quasar-status-heading h2,
.quasar-settings-header h1,
.quasar-group-title h2 {
  margin: 0;
  color: var(--quasar-ink);
  font-size: 20px;
  font-weight: 700;
}

.quasar-text-action {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 4px;
  color: var(--quasar-secondary);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
}

.quasar-text-action:hover {
  color: var(--quasar-ink);
}

.quasar-text-action .bx {
  font-size: 22px;
}

.quasar-runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--quasar-line);
}

.quasar-runtime-row {
  min-width: 0;
  gap: 12px;
  padding: 20px 0;
  border-bottom: 1px solid var(--quasar-line);
}

.quasar-runtime-row:nth-child(odd) {
  padding-right: 24px;
}

.quasar-runtime-row:nth-child(even) {
  padding-left: 24px;
  border-left: 1px solid var(--quasar-line);
}

.quasar-runtime-row > .bx {
  flex: 0 0 auto;
  color: var(--quasar-secondary);
  font-size: 24px;
}

.quasar-runtime-row div {
  min-width: 0;
  flex: 1;
}

.quasar-runtime-row h3,
.quasar-setting-row h2,
.quasar-setting-row h3 {
  margin: 0;
  color: var(--quasar-ink);
  font-size: 15px;
  font-weight: 500;
}

.quasar-runtime-row p,
.quasar-setting-row p {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--quasar-secondary);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quasar-runtime-row strong {
  flex: 0 0 auto;
  color: var(--quasar-ink);
  font-size: 16px;
  font-weight: 700;
}

.quasar-settings-surface {
  width: min(100%, 760px);
  margin: 0 auto;
  padding: 32px;
}

.quasar-settings-header {
  position: relative;
  min-height: 48px;
  justify-content: center;
  margin-bottom: 24px;
}

.quasar-settings-header .quasar-icon-button {
  position: absolute;
  left: -8px;
}

.quasar-setting-list {
  display: grid;
  gap: 24px;
}

.quasar-setting-row {
  min-width: 0;
  justify-content: space-between;
  gap: 24px;
}

.quasar-setting-row > div:first-child {
  min-width: 0;
}

.quasar-divider {
  height: 1px;
  background: var(--quasar-line);
}

.quasar-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quasar-group-title .bx {
  color: var(--quasar-ink);
  font-size: 24px;
}

.quasar-slide-forward-enter-active,
.quasar-slide-forward-leave-active,
.quasar-slide-back-enter-active,
.quasar-slide-back-leave-active {
  transition:
    opacity 125ms var(--quasar-motion-ease),
    transform 125ms var(--quasar-motion-ease);
}

.quasar-slide-forward-enter-from {
  opacity: 0;
  transform: translateX(120px);
}

.quasar-slide-forward-leave-to {
  opacity: 0;
  transform: translateX(-120px);
}

.quasar-slide-back-enter-from {
  opacity: 0;
  transform: translateX(-120px);
}

.quasar-slide-back-leave-to {
  opacity: 0;
  transform: translateX(120px);
}

.quasar-fade-enter-active,
.quasar-fade-leave-active {
  transition: opacity 125ms var(--quasar-motion-ease);
}

.quasar-fade-enter-from,
.quasar-fade-leave-to {
  opacity: 0;
}

@media (max-width: 767px) {
  .quasar-demo-shell {
    padding: 20px 16px 88px;
  }

  .quasar-frame {
    min-height: 0;
    padding: 8px 0 40px;
  }

  .quasar-watermark {
    right: -180px;
    bottom: 24px;
    font-size: 500px;
  }

  .quasar-brand {
    font-size: 52px;
  }

  .quasar-command-status {
    display: none;
  }

  .quasar-actions {
    gap: 10px;
  }

  .quasar-chip {
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  .quasar-status-surface,
  .quasar-settings-surface {
    padding: 24px 20px;
  }

  .quasar-runtime-grid {
    grid-template-columns: 1fr;
  }

  .quasar-runtime-row:nth-child(odd),
  .quasar-runtime-row:nth-child(even) {
    padding-right: 0;
    padding-left: 0;
    border-left: 0;
  }

  .quasar-setting-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .quasar-slide-forward-enter-from {
    transform: translateX(72px);
  }

  .quasar-slide-forward-leave-to {
    transform: translateX(-72px);
  }

  .quasar-slide-back-enter-from {
    transform: translateX(-72px);
  }

  .quasar-slide-back-leave-to {
    transform: translateX(72px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .quasar-scope *,
  .quasar-scope *::before,
  .quasar-scope *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }

  .quasar-slide-forward-enter-from,
  .quasar-slide-forward-leave-to,
  .quasar-slide-back-enter-from,
  .quasar-slide-back-leave-to {
    transform: none;
  }
}
</style>
