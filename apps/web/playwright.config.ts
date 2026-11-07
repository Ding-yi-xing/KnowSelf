import { defineConfig, devices } from "@playwright/test";

/**
 * 新前端 e2e 配置。旧前端的 globalSetup/globalTeardown 已随旧实现移除；
 * 试点页导航用例不依赖后端数据，可在 Vite dev server 启动后直接运行。
 */
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  retries: 1,
  timeout: 30000,
});
