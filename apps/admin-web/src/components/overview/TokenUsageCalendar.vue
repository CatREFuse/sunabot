<script setup lang="ts">
import { computed, nextTick, onMounted, useTemplateRef, watch } from "vue";
import type { TokenUsagePayload } from "../../types";
import { formatExactNumber } from "../../utils/numberFormat";

const props = defineProps<{ days: TokenUsagePayload["days"] }>();
const calendarWrap = useTemplateRef<HTMLElement>("calendarWrap");
const dayMap = computed(() => new Map(props.days.map((day) => [day.date, day.total])));
const maxDay = computed(() => Math.max(1, ...dayMap.value.values()));
const calendar = computed(() => {
  const values: Array<{ date: string; total: number; level: number }> = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let offset = 370; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const total = dayMap.value.get(key) ?? 0;
    values.push({ date: key, total, level: total ? Math.max(1, Math.ceil(total / maxDay.value * 4)) : 0 });
  }
  return values;
});

async function showLatestDays() {
  await nextTick();
  if (calendarWrap.value) calendarWrap.value.scrollLeft = calendarWrap.value.scrollWidth;
}

onMounted(showLatestDays);
watch(() => props.days, showLatestDays);
</script>

<template>
  <article class="usage-calendar">
    <header><span class="usage-card__label"><i class="bx bx-grid-alt" aria-hidden="true"></i>最近 53 周</span><span>每日总量</span></header>
    <div ref="calendarWrap" class="calendar-wrap">
      <div class="calendar" role="img" aria-label="每日 Token 消耗日历">
        <span v-for="day in calendar" :key="day.date" :data-level="day.level" :title="`${day.date} · ${formatExactNumber(day.total)} tokens`"></span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.usage-calendar { min-width: 0; overflow: hidden; border: 1px solid rgb(var(--color-line)); border-radius: 14px; background: rgb(var(--color-panel)); padding: 16px; }
.usage-calendar header { display: flex; justify-content: space-between; gap: 12px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 9px; }
.usage-card__label { display: flex; align-items: center; gap: 7px; color: rgb(var(--color-mute)); font-family: "Space Mono", monospace; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.calendar-wrap { margin-top: 20px; overflow-x: auto; padding-bottom: 4px; }
.calendar { display: grid; width: max-content; grid-auto-flow: column; grid-template-rows: repeat(7, 10px); gap: 3px; }
.calendar span { width: 10px; height: 10px; border: 1px solid rgb(var(--color-line)); background: rgb(var(--color-raised)); }
.calendar span[data-level="1"] { background: color-mix(in srgb, rgb(var(--color-success)) 30%, rgb(var(--color-page))); }
.calendar span[data-level="2"] { background: color-mix(in srgb, rgb(var(--color-success)) 50%, rgb(var(--color-page))); }
.calendar span[data-level="3"] { background: color-mix(in srgb, rgb(var(--color-success)) 72%, rgb(var(--color-page))); }
.calendar span[data-level="4"] { background: rgb(var(--color-success)); }
</style>
