<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import ReleaseTimeline from "../components/releases/ReleaseTimeline.vue";
import VersionSummary from "../components/releases/VersionSummary.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { useReleaseCatalog } from "../composables/useReleaseCatalog";

const releases = useReleaseCatalog();
const currentRelease = computed(() => releases.catalog.value?.releases.find(
  (release) => release.version === releases.catalog.value?.currentVersion
) ?? null);

onMounted(() => void releases.load());
onBeforeUnmount(() => releases.dispose());
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="版本更新" description="查看当前版本与每次发布内容。">
        <template #actions>
          <button class="btn" type="button" :disabled="releases.loading.value" @click="releases.load">
            <i class="bx" :class="releases.loading.value ? 'bx-loader-alt bx-spin' : 'bx-refresh'" aria-hidden="true"></i>
            {{ releases.loading.value ? "刷新中" : "刷新" }}
          </button>
        </template>
      </PageHeader>

      <p v-if="releases.error.value && releases.catalog.value" class="mb-5 text-sm text-accent" role="alert">
        {{ releases.error.value }}
      </p>

      <div v-if="releases.loading.value && !releases.catalog.value" class="empty-state">
        <div><i class="bx bx-loader-alt bx-spin text-2xl" aria-hidden="true"></i><strong class="mt-3">正在读取版本</strong></div>
      </div>
      <div v-else-if="releases.error.value && !releases.catalog.value" class="empty-state" role="alert">
        <div>
          <strong class="!text-accent">{{ releases.error.value }}</strong>
          <button class="btn mt-5" type="button" @click="releases.load">重试</button>
        </div>
      </div>
      <template v-else-if="releases.catalog.value && currentRelease">
        <VersionSummary :release="currentRelease" />
        <ReleaseTimeline :releases="releases.catalog.value.releases" />
      </template>
    </div>
  </div>
</template>
