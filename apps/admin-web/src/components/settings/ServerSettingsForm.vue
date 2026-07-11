<script setup lang="ts">
import type { ConfigSectionValueMap } from "../../types";
const draft = defineModel<ConfigSectionValueMap["server"]>({ required: true });
</script>

<template>
  <section class="grid gap-8">
    <div>
      <p class="page-kicker">SERVER</p>
      <h2 class="section-title mt-2">服务监听</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2">
      <label class="field">
        <span class="field-label">Host</span>
        <input v-model.trim="draft.host" class="control" type="text" autocomplete="off">
        <small class="font-mono text-[10px] text-warning">[RESTART]</small>
      </label>
      <label class="field">
        <span class="field-label">Port</span>
        <input v-model.number="draft.port" class="control" type="number" min="1" max="65535" step="1">
        <small class="font-mono text-[10px] text-warning">[RESTART]</small>
      </label>
    </div>
  </section>
</template>
