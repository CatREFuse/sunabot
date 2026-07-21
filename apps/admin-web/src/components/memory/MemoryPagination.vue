<script setup lang="ts">
const props = defineProps<{
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  loading?: boolean;
}>();
const emit = defineEmits<{ change: [page: number] }>();

function changePage(nextPage: number) {
  if (props.loading || nextPage < 1 || nextPage > props.pageCount || nextPage === props.page) return;
  emit("change", nextPage);
}
</script>

<template>
  <nav v-if="pageCount > 1" class="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between" aria-label="记忆分页">
    <p class="font-mono text-[10px] text-mute">
      共 {{ total.toLocaleString("zh-CN") }} 条 · 每页 {{ pageSize.toLocaleString("zh-CN") }} 条
    </p>
    <div class="flex items-center justify-between gap-3 sm:justify-end">
      <button class="btn btn-ghost" type="button" :disabled="loading || page <= 1" @click="changePage(page - 1)"><i class="bx bx-chevron-left" aria-hidden="true"></i>上一页</button>
      <span class="min-w-16 text-center font-mono text-[10px] text-mute" aria-live="polite">{{ page.toLocaleString("zh-CN") }} / {{ pageCount.toLocaleString("zh-CN") }}</span>
      <button class="btn btn-ghost" type="button" :disabled="loading || page >= pageCount" @click="changePage(page + 1)">下一页<i class="bx bx-chevron-right" aria-hidden="true"></i></button>
    </div>
  </nav>
</template>
