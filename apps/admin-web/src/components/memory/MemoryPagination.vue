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
  <nav v-if="pageCount > 1" class="flex items-center justify-between gap-4 border-t border-line py-4" aria-label="记忆分页">
    <p class="font-mono text-[11px] text-mute">
      {{ total.toLocaleString("zh-CN") }} 条 · {{ page.toLocaleString("zh-CN") }} / {{ pageCount.toLocaleString("zh-CN") }}
    </p>
    <div class="flex items-center gap-1">
      <button class="icon-btn" type="button" :disabled="loading || page <= 1" aria-label="上一页" @click="changePage(page - 1)">
        <i class="bx bx-left-arrow-alt" aria-hidden="true"></i>
      </button>
      <span class="hidden font-mono text-[11px] text-disabled sm:inline">每页 {{ pageSize.toLocaleString("zh-CN") }}</span>
      <button class="icon-btn" type="button" :disabled="loading || page >= pageCount" aria-label="下一页" @click="changePage(page + 1)">
        <i class="bx bx-right-arrow-alt" aria-hidden="true"></i>
      </button>
    </div>
  </nav>
</template>
