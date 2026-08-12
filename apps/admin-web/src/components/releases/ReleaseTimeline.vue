<script setup lang="ts">
import type { ReleaseRecord } from "../../types/releases";

defineProps<{ releases: readonly ReleaseRecord[] }>();
</script>

<template>
  <section aria-labelledby="release-history-heading" class="pt-10 md:pt-14">
    <div class="flex min-w-0 items-end justify-between gap-6 border-b border-visible pb-5">
      <h2 id="release-history-heading" class="section-title">更新日志</h2>
      <span class="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">{{ releases.length }} 个版本</span>
    </div>

    <ol class="min-w-0">
      <li v-for="release in releases" :key="release.version" class="border-b border-line py-8 md:py-10">
        <article class="grid min-w-0 gap-8 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
          <header class="min-w-0">
            <p class="font-display text-3xl font-semibold leading-none tracking-[-0.03em] text-display">v{{ release.version }}</p>
            <p class="mt-3 text-base font-medium text-display">{{ release.title }}</p>
            <time :datetime="release.releasedAt" class="mt-2 block font-mono text-[11px] text-mute">{{ release.releasedAt }}</time>
          </header>

          <div class="grid min-w-0 gap-8 md:grid-cols-3 md:gap-6">
            <section v-for="group in release.groups" :key="group.title" class="min-w-0">
              <h3 class="meta-label text-ink">{{ group.title }}</h3>
              <ol class="mt-4 grid gap-4">
                <li v-for="(item, index) in group.items" :key="item" class="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-3 text-sm leading-6 text-ink">
                  <span class="font-mono text-[10px] text-disabled" aria-hidden="true">{{ String(index + 1).padStart(2, "0") }}</span>
                  <span>{{ item }}</span>
                </li>
              </ol>
            </section>
          </div>
        </article>
      </li>
    </ol>
  </section>
</template>
