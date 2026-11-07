import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/server/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.tsx",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "html", "lcov"],
    include: [
      "packages/profile-store/src/**",
      "packages/context-router/src/**",
      "packages/ingestion/src/**",
      "apps/server/src/**",
    ],
    exclude: ["**/index.ts", "**/*.test.ts", "**/*.spec.ts", "**/tests/**"],
    thresholds: {
      lines: 65,
      branches: 60,
      statements: 65,
      functions: 65,
    },
  },
});
