<script setup lang="ts">
import { computed } from "vue";
import type { ReleaseRecord } from "../../types/releases";

const props = defineProps<{ release: ReleaseRecord }>();

const releaseDate = computed(() => formatReleaseDate(props.release.releasedAt));

function formatReleaseDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}
</script>

<template>
  <section aria-labelledby="current-version-heading" class="border-y border-visible py-8 md:py-10">
    <div class="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,0.65fr)] lg:items-end">
      <div class="min-w-0">
        <p class="meta-label">Current release</p>
        <h2 id="current-version-heading" class="mt-4 break-all font-display text-[clamp(3rem,11vw,6.5rem)] font-semibold leading-[0.82] tracking-[-0.05em] text-display">
          v{{ release.version }}
        </h2>
        <p class="mt-6 max-w-2xl text-base leading-7 text-ink md:text-lg">{{ release.summary }}</p>
      </div>

      <dl class="border-t border-line lg:border-t-0">
        <div class="divider-row">
          <dt class="meta-label">状态</dt>
          <dd class="font-mono text-xs text-success">当前发行</dd>
        </div>
        <div class="divider-row">
          <dt class="meta-label">名称</dt>
          <dd class="text-sm text-display">{{ release.title }}</dd>
        </div>
        <div class="divider-row">
          <dt class="meta-label">发布日期</dt>
          <dd class="text-sm text-display"><time :datetime="release.releasedAt">{{ releaseDate }}</time></dd>
        </div>
      </dl>
    </div>
  </section>
</template>
