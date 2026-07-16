<script setup lang="ts">
import { onMounted } from "vue";
import ConfigDoctorPanel from "../components/settings/ConfigDoctorPanel.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import { useConfigDoctor } from "../composables/useConfigDoctor";

const doctor = useConfigDoctor();

onMounted(() => void doctor.scan());
</script>

<template>
  <div class="page-shell">
    <div class="page-frame">
      <PageHeader title="配置医生" description="检查系统配置，并在确认后修复可恢复的问题。" />

      <ConfigDoctorPanel
        :report="doctor.report.value"
        :apply-result="doctor.applyResult.value"
        :scanning="doctor.scanning.value"
        :proposing="doctor.proposing.value"
        :applying="doctor.applying.value"
        :error="doctor.error.value"
        :message="doctor.message.value"
        @scan="doctor.scan"
        @propose="doctor.propose"
        @apply="doctor.apply"
      />
    </div>
  </div>
</template>
