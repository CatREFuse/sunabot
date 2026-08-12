import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/user-test-harness/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true
  }
});
