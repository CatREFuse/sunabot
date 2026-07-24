<script setup lang="ts">
import type { DirectorSchedule } from "../../types/director";

defineProps<{ schedules: readonly DirectorSchedule[]; loading: boolean }>();

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : "—";
}

function sourceLabel(source: DirectorSchedule["source"]) {
  return source === "character_revision" ? "已调整" : "初始决策";
}
</script>

<template>
  <section class="decision-list" aria-label="每日决策">
    <div v-if="schedules.length" class="divide-y divide-line">
      <details v-for="schedule in schedules" :key="`${schedule.date}:${schedule.revision}`" class="decision-item" :open="schedule === schedules[0]">
        <summary class="decision-summary">
          <span class="decision-date">{{ schedule.date }}</span>
          <span class="decision-copy">
            <strong>{{ schedule.theme }}</strong>
            <span>{{ schedule.summary }}</span>
          </span>
          <span class="decision-meta">
            <span class="inline-state">{{ sourceLabel(schedule.source) }}</span>
            <span>R{{ schedule.revision }}</span>
            <i class="bx bx-chevron-down" aria-hidden="true"></i>
          </span>
        </summary>

        <div class="decision-body">
          <ol class="decision-timeline">
            <li v-for="item in schedule.items" :key="item.id">
              <time>{{ dateTime(item.startAt) }} — {{ dateTime(item.endAt) }}</time>
              <div>
                <strong>{{ item.activity }}</strong>
                <p>{{ item.location }}<template v-if="item.participants.length"> · {{ item.participants.join("、") }}</template></p>
                <p>{{ item.intent }}</p>
                <p v-if="item.share.enabled" class="decision-share">
                  分享 {{ dateTime(item.share.at || "") }}<template v-if="item.share.textIntent"> · {{ item.share.textIntent }}</template>
                </p>
              </div>
            </li>
          </ol>
          <p class="decision-updated">更新于 {{ dateTime(schedule.updatedAt) }} · {{ schedule.timeZone }}</p>
        </div>
      </details>
    </div>

    <div v-else class="empty-state">
      <strong>{{ loading ? "正在读取每日决策" : "还没有每日决策" }}</strong>
    </div>
  </section>
</template>

<style scoped>
.decision-item { border: 0; }
.decision-summary {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr) auto;
  gap: 24px;
  align-items: center;
  min-height: 88px;
  padding: 16px 0;
  cursor: pointer;
  list-style: none;
}
.decision-summary::-webkit-details-marker { display: none; }
.decision-summary:focus-visible { outline: 2px solid rgb(var(--color-display)); outline-offset: 4px; }
.decision-date { color: rgb(var(--color-display)); font-family: "Space Mono", monospace; font-size: 12px; }
.decision-copy { display: grid; gap: 6px; min-width: 0; }
.decision-copy strong { color: rgb(var(--color-display)); font-size: 14px; font-weight: 500; }
.decision-copy span { color: rgb(var(--color-mute)); font-size: 12px; line-height: 1.6; }
.decision-meta { display: flex; align-items: center; gap: 10px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; }
.decision-meta i { font-size: 18px; transition: transform 160ms ease; }
.decision-item[open] .decision-meta i { transform: rotate(180deg); }
.decision-body { padding: 0 0 24px 136px; }
.decision-timeline { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.decision-timeline li { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 16px; border-top: 1px solid rgb(var(--color-line)); padding: 16px 0; }
.decision-timeline time { color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; line-height: 1.7; }
.decision-timeline strong { color: rgb(var(--color-display)); font-size: 13px; font-weight: 500; }
.decision-timeline p { margin-top: 5px; color: rgb(var(--color-mute)); font-size: 11px; line-height: 1.55; }
.decision-timeline .decision-share { color: rgb(var(--color-ink)); }
.decision-updated { color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
@media (max-width: 767px) {
  .decision-summary { grid-template-columns: 1fr auto; gap: 12px; min-height: 96px; }
  .decision-date { grid-column: 1; }
  .decision-copy { grid-column: 1 / -1; grid-row: 2; }
  .decision-meta { grid-column: 2; grid-row: 1; }
  .decision-body { padding-left: 0; }
  .decision-timeline li { grid-template-columns: 1fr; gap: 8px; }
}
</style>
