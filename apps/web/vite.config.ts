/**
 * Vite 配置 — 结构对齐 deepseek-harness `apps/web/vite.config.ts` 的独立壳约定：
 *   - 单一 React 插件、显式 dedupe（避免 React 双实例分裂 hook 身份，dsh 的 resolve.dedupe）
 *   - 明确的 build target / sourcemap / outDir
 * 与 dsh 原壳的差异（B1 裁剪，刻意为之）：
 *   - 移除 rejectStandaloneServe()：本壳由 Vite 独立 dev/serve，不依赖 dsh web 启动清单
 *   - 移除 clientBuildEnvironmentDefines / productWebBundleIsolation / katex 字体插件：
 *     这些属于 dsh agent host 与插件加载器，knowSelf 不需要
 *   - 不注入 window.__DSH_BOOT__；入口直接 createRoot
 * 代理目标沿用项目后端 9527，使 /api/* 与迁移前行为一致。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = "http://127.0.0.1:9527";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: false },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
