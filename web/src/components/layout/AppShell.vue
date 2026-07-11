<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { RouterView } from "vue-router";
import { useAdminApi } from "../../composables/useAdminApi";
import { useRuntimeStatus } from "../../composables/useRuntimeStatus";
import { useTheme } from "../../composables/useTheme";
import AdminLoginGate from "./AdminLoginGate.vue";
import DesktopNavigation from "./DesktopNavigation.vue";
import MobileNavigation from "./MobileNavigation.vue";

useTheme();
const api = useAdminApi();
const runtime = useRuntimeStatus();
onMounted(async () => {
  try {
    const session = await api.initialize();
    if (session.authenticated) runtime.start();
  } catch {
    // The login gate renders the actionable state.
  }
});
onUnmounted(runtime.stop);
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 overflow-hidden bg-page">
    <a href="#main-content" class="fixed left-3 top-3 z-[120] inline-flex min-h-11 -translate-y-20 items-center rounded-md bg-display px-4 font-mono text-xs text-page focus:translate-y-0">跳到内容</a>
    <DesktopNavigation />
    <main id="main-content" class="app-main min-h-0 min-w-0 flex-1 self-start overflow-hidden md:self-stretch">
      <RouterView />
    </main>
    <MobileNavigation />
    <AdminLoginGate v-if="api.initialized.value && api.authorizationRequired.value" />
  </div>
</template>
