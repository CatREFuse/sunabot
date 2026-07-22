import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(() => {
  const processLike = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process;
  const apiTarget = processLike?.env?.SUNABOT_API_URL || "http://127.0.0.1:8787";
  return {
    root: "apps/admin-web",
    plugins: [vue()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      assetsInlineLimit: 0,
      manifest: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/echarts")) return "vendor-echarts";
            if (id.includes("node_modules/vue") || id.includes("node_modules/@vue") || id.includes("node_modules/vue-router")) {
              return "vendor-vue";
            }
          }
        }
      }
    },
    server: {
      proxy: {
        "/api": apiTarget,
        "/generated-images": apiTarget
      }
    }
  };
});
