import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(() => {
  const processLike = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process;
  const apiTarget = processLike?.env?.SUNABOT_API_URL || "http://127.0.0.1:8787";
  return {
    root: "web",
    plugins: [vue()],
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      proxy: {
        "/api": apiTarget,
        "/generated-images": apiTarget
      }
    }
  };
});
