import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/runtime-smoke/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true
  }
});
