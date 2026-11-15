import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    /**
     * W-8/B3：跑任何用例之前先自检「Node 大版本 + 原生模块能不能干活」。
     * 与 `scripts/ensure-native.mjs` **复用同一个模块**（`checkEnv()`），
     * 保证 `npm test` 与手动 `node scripts/ensure-native.mjs` 的判定完全一致。
     * 只用 node 内置、只读、失败即抛错终止。
     */
    globalSetup: ["./scripts/vitest-global-setup.mjs"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    include: [
      "packages/*/tests/**/*.test.ts",
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
